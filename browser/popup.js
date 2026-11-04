import { DEFAULT_SETTINGS } from './lib/constants.js';

const $ = (id) => document.getElementById(id);
const bg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg });

let settings = { ...DEFAULT_SETTINGS };
let voices = [];

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

function langName(code) {
  try {
    return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

function renderVoices() {
  const langSel = $('lang');
  const voiceSel = $('voice');
  const currentLang = (voices.find((v) => v.shortName === settings.voice)?.locale || settings.voice).slice(0, 2);
  const langs = [...new Set(voices.map((v) => v.locale.split('-')[0]))]
    .map((code) => ({ code, name: langName(code) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  langSel.replaceChildren(...langs.map(({ code, name }) => new Option(name, code)));
  langSel.value = langSel.dataset.chosen || currentLang;
  if (!langSel.value && langs.length) langSel.value = langs[0].code;

  const shown = voices.filter((v) => v.locale.split('-')[0] === langSel.value);
  voiceSel.replaceChildren(...shown.map((v) => new Option(v.label, v.shortName)));
  if (shown.some((v) => v.shortName === settings.voice)) voiceSel.value = settings.voice;
  else if (!voices.length) voiceSel.append(new Option(settings.voice, settings.voice));
}

async function loadVoices(force = false) {
  $('voiceError').hidden = true;
  const res = await bg({ type: 'getVoices', force });
  if (Array.isArray(res)) {
    voices = res;
    if (!voices.length && settings.backend === 'azure') {
      $('voiceError').textContent = 'Enter your Azure key and region to load voices.';
      $('voiceError').hidden = false;
    }
  } else {
    voices = [];
    $('voiceError').textContent = `Couldn't load voices: ${res?.error || 'unknown error'}`;
    $('voiceError').hidden = false;
  }
  renderVoices();
}

function renderSettings() {
  $('rate').value = settings.rate;
  $('rateOut').textContent = `${Number(settings.rate).toFixed(1)}×`;
  $('pitch').value = settings.pitch;
  $('pitchOut').textContent = `${settings.pitch > 0 ? '+' : ''}${settings.pitch} Hz`;
  $('highlightWords').checked = settings.highlightWords;
  $('autoScroll').checked = settings.autoScroll;
  for (const r of document.querySelectorAll('input[name="backend"]')) r.checked = r.value === settings.backend;
  $('azureFields').hidden = settings.backend !== 'azure';
  $('azureKey').value = settings.azureKey;
  $('azureRegion').value = settings.azureRegion;
  if (settings.backend === 'azure') $('advanced').open = true;
}

async function startReading(mode) {
  $('pageError').hidden = true;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await bg({ type: 'start', tabId: tab.id, mode });
  if (res && res.ok === false) {
    $('pageError').textContent = `Can't read this page (${res.error}). Browser pages, the extension store and the built-in PDF viewer are off-limits to extensions.`;
    $('pageError').hidden = false;
    return;
  }
  window.close();
}

async function init() {
  settings = await bg({ type: 'getSettings' });
  renderSettings();
  loadVoices();

  chrome.commands?.getAll?.((cmds) => {
    const c = cmds.find((x) => x.name === 'read-aloud');
    $('shortcut').textContent = c?.shortcut || 'not set';
  });

  $('readPage').onclick = () => startReading('page');
  $('readSelection').onclick = () => startReading('selection');
  $('stop').onclick = () => bg({ type: 'stopAll' });

  $('lang').onchange = () => {
    $('lang').dataset.chosen = $('lang').value;
    renderVoices();
    if ($('voice').value) save({ voice: $('voice').value });
  };
  $('voice').onchange = () => save({ voice: $('voice').value });
  $('preview').onclick = () => {
    const v = voices.find((x) => x.shortName === settings.voice);
    const name = v?.label.split(/[\s(-]/)[0] || 'your new voice';
    bg({ type: 'preview', text: `Hi, I'm ${name}. This is how I'll sound reading your pages.` });
  };
  $('rate').oninput = () => { $('rateOut').textContent = `${Number($('rate').value).toFixed(1)}×`; };
  $('rate').onchange = () => save({ rate: Number($('rate').value) });
  $('pitch').oninput = () => { $('pitchOut').textContent = `${$('pitch').value > 0 ? '+' : ''}${$('pitch').value} Hz`; };
  $('pitch').onchange = () => save({ pitch: Number($('pitch').value) });
  $('highlightWords').onchange = () => save({ highlightWords: $('highlightWords').checked });
  $('autoScroll').onchange = () => save({ autoScroll: $('autoScroll').checked });

  for (const r of document.querySelectorAll('input[name="backend"]')) {
    r.onchange = async () => {
      await save({ backend: r.value });
      renderSettings();
      loadVoices();
    };
  }
  const saveAzure = async () => {
    await save({ azureKey: $('azureKey').value.trim(), azureRegion: $('azureRegion').value.trim() || 'eastus' });
    loadVoices(true);
  };
  $('azureKey').onchange = saveAzure;
  $('azureRegion').onchange = saveAzure;
}

init();
