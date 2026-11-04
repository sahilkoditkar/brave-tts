import {
  DEFAULT_SETTINGS, EDGE_EXTENSION_ORIGIN, EDGE_USER_AGENT, EDGE_SEC_CH_UA,
} from './lib/constants.js';
import { generateMuid } from './lib/drm.js';
import { listVoices } from './lib/tts.js';

// ---------- settings ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

// ---------- make our requests to the Edge endpoint look like Edge's own ----------
async function installHeaderRules() {
  let { muid } = await chrome.storage.local.get('muid');
  if (!muid) {
    muid = generateMuid();
    await chrome.storage.local.set({ muid });
  }
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: EDGE_EXTENSION_ORIGIN },
          { header: 'User-Agent', operation: 'set', value: EDGE_USER_AGENT },
          { header: 'Sec-CH-UA', operation: 'set', value: EDGE_SEC_CH_UA },
          { header: 'Cookie', operation: 'set', value: `muid=${muid};` },
          { header: 'Pragma', operation: 'set', value: 'no-cache' },
          { header: 'Cache-Control', operation: 'set', value: 'no-cache' },
        ],
      },
      condition: {
        requestDomains: ['speech.platform.bing.com'],
        resourceTypes: ['websocket', 'xmlhttprequest', 'other'],
      },
    }],
  });
}

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: 'Read aloud selection', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-page', title: 'Read aloud this page', contexts: ['page'] });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  installHeaderRules();
  createMenus();
});
chrome.runtime.onStartup.addListener(installHeaderRules);

// ---------- offscreen player ----------
let creating = null;
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play synthesized speech for Read Aloud',
    }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; })
      .finally(() => { creating = null; });
  }
  await creating;
}

async function toOffscreen(msg) {
  await ensureOffscreen();
  if (msg.type === 'load' || msg.type === 'settings') msg.settings = await getSettings();
  return chrome.runtime.sendMessage({ ...msg, to: 'offscreen' });
}

// ---------- injecting the page reader ----------
async function startInTab(tabId, mode) {
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (err) {
    console.warn('Cannot read this page:', err);
    chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
    chrome.action.setBadgeText({ tabId, text: '!' });
    chrome.action.setTitle({ tabId, title: `Read Aloud can't run on this page: ${err.message}` });
    return { ok: false, error: err.message };
  }
  return chrome.tabs.sendMessage(tabId, { to: 'content', cmd: mode });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  startInTab(tab.id, info.menuItemId === 'read-selection' ? 'selection' : 'page');
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'read-aloud' && tab?.id) startInTab(tab.id, 'toggle');
});

// Stop playback when the reading tab goes away or navigates.
async function stopForTab(tabId) {
  if (await hasOffscreen()) chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop', tabId }).catch(() => {});
}
chrome.tabs.onRemoved.addListener((tabId) => stopForTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) stopForTab(tabId);
});

// Settings edited in popup or player bar -> apply to the player immediately.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes.settings && await hasOffscreen()) {
    chrome.runtime.sendMessage({ to: 'offscreen', type: 'settings', settings: await getSettings() }).catch(() => {});
  }
});

// ---------- voices ----------
async function getVoices(force) {
  const settings = await getSettings();
  const key = `voices:${settings.backend}:${settings.backend === 'azure' ? settings.azureRegion : ''}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (!force && cached && Date.now() - cached.at < 24 * 3600 * 1000 && cached.list.length) return cached.list;
  const list = await listVoices(settings);
  list.sort((a, b) => a.locale.localeCompare(b.locale) || a.label.localeCompare(b.label));
  await chrome.storage.local.set({ [key]: { at: Date.now(), list } });
  return list;
}

// ---------- message routing ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // offscreen -> content script relay
  if (msg?.to === 'tab') {
    const { to, tabId, ...rest } = msg;
    chrome.tabs.sendMessage(tabId, { to: 'content', ...rest }).catch(() => {
      // tab is gone: stop playing into the void
      chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop', tabId }).catch(() => {});
    });
    return;
  }
  if (msg?.to !== 'bg') return;

  const reply = (p) => {
    p.then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  };
  switch (msg.type) {
    case 'offscreen': // from content script
      return reply(toOffscreen({ ...msg.msg, tabId: sender.tab?.id }));
    case 'start': // from popup
      return reply(startInTab(msg.tabId, msg.mode));
    case 'stopAll':
      return reply(hasOffscreen().then((has) => has && chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' })));
    case 'preview':
      return reply(toOffscreen({ type: 'load', tabId: null, texts: [msg.text], start: 0 }));
    case 'getVoices':
      return reply(getVoices(msg.force));
    case 'getSettings':
      return reply(getSettings());
    default:
  }
});
