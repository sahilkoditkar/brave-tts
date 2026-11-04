// Injected into the page on demand. Extracts readable text, splits it into
// sentences, shows a small player bar, and highlights the sentence/word being spoken.
(() => {
  if (window.__braveTtsLoaded) return;
  window.__braveTtsLoaded = true;

  // ---------------- messaging ----------------
  const toBg = (msg) => chrome.runtime.sendMessage({ to: 'bg', ...msg });
  const off = (msg) => toBg({ type: 'offscreen', msg });

  // ---------------- text extraction ----------------
  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'SVG', 'CANVAS',
    'IFRAME', 'TEMPLATE', 'BUTTON', 'VIDEO', 'AUDIO', 'MATH', 'BRAVE-TTS-PLAYER',
  ]);
  const PAGE_SKIP_TAGS = new Set(['NAV', 'FOOTER', 'ASIDE', 'HEADER', 'FORM', 'MENU']);
  const PAGE_SKIP_ROLES = new Set(['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'dialog']);

  function findMainRoot() {
    const candidates = document.querySelectorAll('article, main, [role="main"], [itemprop="articleBody"], #content, #main');
    const bodyLen = document.body.innerText.length;
    let best = null;
    let bestLen = 0;
    for (const el of candidates) {
      const len = el.innerText.length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    return best && bestLen > 0.3 * bodyLen ? best : document.body;
  }

  function extract({ range, root, pageMode }) {
    const visible = new Map();
    const blocks = new Map();
    const isVisible = (el) => {
      if (!visible.has(el)) {
        visible.set(el, el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!el.getClientRects().length);
      }
      return visible.get(el);
    };
    const blockOf = (el) => {
      let cur = el;
      const chain = [];
      while (cur && cur !== document.body) {
        if (blocks.has(cur)) break;
        chain.push(cur);
        const d = getComputedStyle(cur).display;
        if (!d.startsWith('inline') && d !== 'contents' && d !== 'ruby') {
          blocks.set(cur, cur);
          chain.pop();
          break;
        }
        cur = cur.parentElement;
      }
      const result = cur && cur !== document.body ? blocks.get(cur) : document.body;
      for (const c of chain) blocks.set(c, result);
      return result;
    };

    const filter = {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (range && !range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        const el = node;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.getAttribute('aria-hidden') === 'true') return NodeFilter.FILTER_REJECT;
        if (pageMode) {
          if (PAGE_SKIP_TAGS.has(el.tagName) && el !== root) return NodeFilter.FILTER_REJECT;
          if (PAGE_SKIP_ROLES.has(el.getAttribute('role'))) return NodeFilter.FILTER_REJECT;
          // Wikipedia-style "[edit]" links and citation markers
          if (el.classList.contains('mw-editsection') || (el.tagName === 'SUP' && el.classList.contains('reference'))) {
            return NodeFilter.FILTER_REJECT;
          }
        }
        if (!isVisible(el)) return NodeFilter.FILTER_REJECT;
        if (range && !range.intersectsNode(el)) return NodeFilter.FILTER_REJECT;
        return el.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    };

    let flat = '';
    const segs = []; // { node, flatStart, nodeOffset, len }
    let lastBlock = null;
    const lineBreak = () => { if (flat && !flat.endsWith('\n')) flat += '\n'; };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, filter);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType !== Node.TEXT_NODE) { lineBreak(); continue; } // <br>
      const data = node.data;
      let a = 0;
      let b = data.length;
      if (range) {
        if (node === range.startContainer) a = range.startOffset;
        if (node === range.endContainer) b = range.endOffset;
      }
      const piece = data.slice(a, b);
      if (!/\S/.test(piece)) {
        if (flat && !/\s$/.test(flat)) flat += ' ';
        continue;
      }
      const block = blockOf(node.parentElement);
      if (block !== lastBlock) { lineBreak(); lastBlock = block; }
      segs.push({ node, flatStart: flat.length, nodeOffset: a, len: b - a });
      // keep 1:1 length so offsets map back to the DOM; "\n" is reserved for paragraph breaks
      flat += piece.replace(/[\r\n\t\f\v]/g, ' ');
    }
    return { flat, segs };
  }

  const MAX_SENTENCE = 600;
  const ABBREVIATION_END = /(?:\b(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Gen|Col|Lt|Sgt|Capt|Rev|Hon|vs|approx|Fig|No|e\.g|i\.e)|(?:^|\s)\p{Lu})\.$/u;
  function splitSentences(flat) {
    const lang = document.documentElement.lang || navigator.language || 'en';
    let segmenter;
    try { segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' }); } catch { segmenter = new Intl.Segmenter('en', { granularity: 'sentence' }); }
    const out = [];
    const push = (start, text) => {
      const lead = text.length - text.trimStart().length;
      text = text.trim();
      start += lead;
      if (!/[\p{L}\p{N}]/u.test(text)) return;
      while (text.length > MAX_SENTENCE) {
        const window = text.slice(0, MAX_SENTENCE);
        let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
        if (cut < MAX_SENTENCE / 3) cut = window.lastIndexOf(' ');
        if (cut < 1) cut = MAX_SENTENCE - 1;
        out.push({ start, text: text.slice(0, cut + 1).trim() });
        const rest = text.slice(cut + 1);
        start += cut + 1 + (rest.length - rest.trimStart().length);
        text = rest.trim();
      }
      if (text) out.push({ start, text });
    };
    let pos = 0;
    for (const para of flat.split('\n')) {
      // The segmenter splits after "Dr." or "J." etc.; glue those back on.
      let pendStart = -1;
      let pendEnd = 0;
      for (const { segment, index } of segmenter.segment(para)) {
        if (pendStart >= 0 && ABBREVIATION_END.test(para.slice(pendStart, pendEnd).trimEnd())) {
          pendEnd = index + segment.length;
          continue;
        }
        if (pendStart >= 0) push(pos + pendStart, para.slice(pendStart, pendEnd));
        pendStart = index;
        pendEnd = index + segment.length;
      }
      if (pendStart >= 0) push(pos + pendStart, para.slice(pendStart, pendEnd));
      pos += para.length + 1;
    }
    return out;
  }

  // ---------------- mapping text offsets back to DOM ranges ----------------
  let doc = null; // { flat, segs, sentences }

  function segIndexAt(pos) {
    const { segs } = doc;
    let lo = 0;
    let hi = segs.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (segs[m].flatStart <= pos) { ans = m; lo = m + 1; } else hi = m - 1;
    }
    return ans;
  }

  function makeRange(a, b) {
    const { segs } = doc;
    if (!segs.length || b <= a) return null;
    let i = segIndexAt(a);
    if (a >= segs[i].flatStart + segs[i].len && i + 1 < segs.length) { i++; a = segs[i].flatStart; }
    const j = segIndexAt(b - 1);
    try {
      const r = document.createRange();
      r.setStart(segs[i].node, segs[i].nodeOffset + Math.max(0, a - segs[i].flatStart));
      r.setEnd(segs[j].node, segs[j].nodeOffset + Math.min(segs[j].len, b - segs[j].flatStart));
      return r;
    } catch {
      return null; // page changed underneath us
    }
  }

  function sentenceAtDomPoint(node, offset) {
    if (!doc) return -1;
    const seg = doc.segs.find((s) => s.node === node);
    if (!seg) return -1;
    const pos = seg.flatStart + Math.max(0, offset - seg.nodeOffset);
    let found = -1;
    for (let k = 0; k < doc.sentences.length; k++) {
      if (doc.sentences[k].start <= pos) found = k; else break;
    }
    return found;
  }

  // ---------------- highlighting ----------------
  const hasHighlights = typeof Highlight !== 'undefined' && CSS.highlights;
  const hlSentence = hasHighlights ? new Highlight() : null;
  const hlWord = hasHighlights ? new Highlight() : null;
  if (hasHighlights) {
    hlWord.priority = 1;
    CSS.highlights.set('brave-tts-sentence', hlSentence);
    CSS.highlights.set('brave-tts-word', hlWord);
  }
  let lastUserScroll = 0;
  const markUserScroll = () => { lastUserScroll = Date.now(); };

  function highlightSentence(i) {
    if (!hasHighlights) return;
    hlSentence.clear();
    hlWord.clear();
    const s = doc?.sentences[i];
    if (!s) return;
    const r = makeRange(s.start, s.start + s.text.length);
    if (!r) return;
    hlSentence.add(r);
    if (settings.autoScroll && Date.now() - lastUserScroll > 4000) {
      const rect = r.getBoundingClientRect();
      if (rect.height && (rect.top < 60 || rect.bottom > innerHeight - 110)) {
        const el = r.startContainer.parentElement;
        el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }

  function highlightWord(i, start, length) {
    if (!hasHighlights || !settings.highlightWords) return;
    const s = doc?.sentences[i];
    if (!s) return;
    hlWord.clear();
    const r = makeRange(s.start + start, s.start + start + length);
    if (r) hlWord.add(r);
  }

  function clearHighlights() {
    hlSentence?.clear();
    hlWord?.clear();
  }

  // ---------------- player bar ----------------
  let settings = {};
  let host = null;
  let ui = null;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    prev: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
    next: 'M16 6h2v12h-2zM6 18l8.5-6L6 6z',
    play: 'M8 5v14l11-7z',
    pause: 'M6 19h4V5H6zm8-14v14h4V5z',
    close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    minus: 'M5 11h14v2H5z',
    plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }
  function el(tag, props = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
    e.append(...children);
    return e;
  }
  function button(name, title, onclick) {
    const b = el('button', { title, 'aria-label': title, onclick, class: `btn ${name}` }, icon(name));
    return b;
  }

  const CSS_TEXT = `
    :host { all: initial; }
    .bar {
      position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
      z-index: 2147483647; display: flex; align-items: center; gap: 4px;
      padding: 6px 8px; border-radius: 999px; max-width: calc(100vw - 32px); box-sizing: border-box;
      background: #202124; color: #e8eaed; box-shadow: 0 4px 18px rgba(0,0,0,.35);
      font: 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; user-select: none;
    }
    .btn {
      all: unset; cursor: pointer; width: 32px; height: 32px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; flex: none;
    }
    .btn:hover { background: rgba(255,255,255,.12); }
    .btn:focus-visible { outline: 2px solid #8ab4f8; }
    .btn svg { width: 20px; height: 20px; fill: currentColor; }
    .btn.small { width: 24px; height: 24px; } .btn.small svg { width: 16px; height: 16px; }
    .play { background: #8ab4f8; color: #202124; }
    .play:hover { background: #aecbfa; }
    .sep { width: 1px; height: 20px; background: rgba(255,255,255,.2); margin: 0 4px; flex: none; }
    select {
      all: unset; cursor: pointer; max-width: 190px; min-width: 0; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; padding: 4px 8px; border-radius: 6px; background: rgba(255,255,255,.08);
    }
    select option { background: #202124; color: #e8eaed; }
    .speed { min-width: 38px; text-align: center; font-variant-numeric: tabular-nums; }
    .status { padding: 0 6px; opacity: .8; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .status.error { color: #f28b82; opacity: 1; white-space: normal; max-width: 320px; }
    @media (max-width: 560px) { select { max-width: 110px; } .status:not(.error) { display: none; } }
  `;

  function buildPlayer() {
    host = document.createElement('brave-tts-player');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS_TEXT);
    shadow.adoptedStyleSheets = [sheet];

    const playBtn = button('play', 'Play / pause (Ctrl+Shift+U)', () => togglePause());
    const voiceSel = el('select', { title: 'Voice', onchange: (e) => saveSettings({ voice: e.target.value }) });
    const speedLabel = el('span', { class: 'speed', title: 'Reading speed' });
    const status = el('span', { class: 'status' });
    const bar = el('div', { class: 'bar', role: 'toolbar', 'aria-label': 'Read aloud' },
      button('prev', 'Previous sentence', () => seek(cur - 1)),
      playBtn,
      button('next', 'Next sentence', () => seek(cur + 1)),
      el('span', { class: 'sep' }),
      voiceSel,
      el('span', { class: 'sep' }),
      Object.assign(button('minus', 'Slower', () => changeSpeed(-0.1)), { className: 'btn small minus' }),
      speedLabel,
      Object.assign(button('plus', 'Faster', () => changeSpeed(0.1)), { className: 'btn small plus' }),
      status,
      button('close', 'Stop reading', () => stop(true)),
    );
    shadow.append(bar);
    document.documentElement.append(host);
    ui = { playBtn, voiceSel, speedLabel, status };
    renderSettings();
    loadVoices();
  }

  function setPlayIcon(playing) {
    if (!ui) return;
    ui.playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
  }
  function setStatus(text, isError = false) {
    if (!ui) return;
    ui.status.textContent = text;
    ui.status.className = isError ? 'status error' : 'status';
    ui.status.title = text;
  }
  function renderSettings() {
    if (!ui) return;
    ui.speedLabel.textContent = `${Number(settings.rate).toFixed(1)}×`;
    if (ui.voiceSel.value !== settings.voice) {
      if (![...ui.voiceSel.options].some((o) => o.value === settings.voice)) {
        ui.voiceSel.append(el('option', { value: settings.voice }, settings.voice));
      }
      ui.voiceSel.value = settings.voice;
    }
  }
  async function loadVoices() {
    const voices = await toBg({ type: 'getVoices' });
    if (!Array.isArray(voices) || !ui) return;
    const pageLang = (document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    const shown = voices.filter((v) => v.locale.toLowerCase().startsWith(pageLang) || v.shortName === settings.voice);
    ui.voiceSel.replaceChildren(...(shown.length ? shown : voices).map((v) => el('option', { value: v.shortName }, v.label)));
    renderSettings();
  }

  let speedTimer = null;
  function changeSpeed(delta) {
    settings.rate = Math.min(3, Math.max(0.5, Math.round((Number(settings.rate) + delta) * 10) / 10));
    renderSettings();
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => saveSettings({ rate: settings.rate }), 450);
  }
  async function saveSettings(patch) {
    const { settings: stored } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...stored, ...patch } });
  }
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'local' && changes.settings && active) {
      settings = await toBg({ type: 'getSettings' });
      renderSettings();
      if (changes.settings.oldValue?.backend !== changes.settings.newValue?.backend) loadVoices();
    }
  });

  // ---------------- controller ----------------
  let active = false;
  let playing = false;
  let cur = 0;

  async function start(mode) {
    if (active) await stop(true);
    settings = await toBg({ type: 'getSettings' });
    const sel = window.getSelection();
    const hasSelection = sel && sel.rangeCount && !sel.isCollapsed && sel.toString().trim();
    let extracted;
    let startIdx = 0;
    if (mode === 'selection' || (mode === 'auto' && hasSelection)) {
      if (!hasSelection) return;
      const range = sel.getRangeAt(0);
      let root = range.commonAncestorContainer;
      if (root.nodeType !== Node.ELEMENT_NODE) root = root.parentElement;
      extracted = extract({ range, root, pageMode: false });
    } else {
      const root = findMainRoot();
      extracted = extract({ root, pageMode: true });
    }
    const sentences = splitSentences(extracted.flat);
    doc = { ...extracted, sentences };
    if (!sentences.length) {
      doc = null;
      flash('Nothing readable found on this page.');
      return;
    }
    // "Read from here": if the user clicked into the text (collapsed caret), start there.
    if (mode !== 'selection' && sel?.rangeCount && sel.isCollapsed) {
      const k = sentenceAtDomPoint(sel.anchorNode, sel.anchorOffset);
      if (k > 0) startIdx = k;
    }
    active = true;
    cur = startIdx;
    sel?.removeAllRanges?.();
    buildPlayer();
    addPageListeners();
    setStatus('Loading…');
    playing = true;
    setPlayIcon(true);
    const res = await off({ type: 'load', texts: sentences.map((s) => s.text), start: startIdx });
    if (!res?.ok) onError(res?.error || 'Could not start the player');
  }

  async function stop(notifyPlayer) {
    if (!active) return;
    active = false;
    playing = false;
    clearHighlights();
    removePageListeners();
    host?.remove();
    host = null;
    ui = null;
    doc = null;
    if (notifyPlayer) await off({ type: 'stop' }).catch(() => {});
  }

  async function reloadAt(i) {
    const res = await off({ type: 'load', texts: doc.sentences.map((s) => s.text), start: i });
    if (!res?.ok) onError(res?.error || 'Could not restart the player');
  }

  async function togglePause() {
    if (!active) return;
    if (playing) {
      playing = false;
      setPlayIcon(false);
      setStatus('Paused');
      await off({ type: 'pause' });
    } else {
      playing = true;
      setPlayIcon(true);
      setStatus(`${cur + 1} / ${doc.sentences.length}`);
      const res = await off({ type: 'resume' });
      // The browser may have closed the idle audio player while paused: reload where we were.
      if (!res?.ok) await reloadAt(cur);
    }
  }

  async function seek(i) {
    if (!active) return;
    i = Math.max(0, Math.min(doc.sentences.length - 1, i));
    cur = i;
    highlightSentence(i);
    playing = true;
    setPlayIcon(true);
    const res = await off({ type: 'seek', idx: i });
    if (!res?.ok) await reloadAt(i);
  }

  function onError(message) {
    playing = false;
    setPlayIcon(false);
    setStatus(message, true);
  }

  function flash(text) {
    const note = el('div', {}, text);
    Object.assign(note.style, {
      position: 'fixed', left: '50%', bottom: '20px', transform: 'translateX(-50%)', zIndex: 2147483647,
      background: '#202124', color: '#e8eaed', padding: '10px 16px', borderRadius: '999px',
      font: '13px system-ui, sans-serif', boxShadow: '0 4px 18px rgba(0,0,0,.35)',
    });
    document.documentElement.append(note);
    setTimeout(() => note.remove(), 2500);
  }

  // Alt+click on any text while reading jumps there.
  function onClick(e) {
    if (!e.altKey || !active) return;
    const pos = document.caretPositionFromPoint
      ? document.caretPositionFromPoint(e.clientX, e.clientY)
      : document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (!pos) return;
    const node = pos.offsetNode ?? pos.startContainer;
    const offset = pos.offset ?? pos.startOffset;
    const k = sentenceAtDomPoint(node, offset);
    if (k >= 0) {
      e.preventDefault();
      e.stopPropagation();
      seek(k);
    }
  }
  function onPageHide() {
    if (active) off({ type: 'stop' });
  }
  function addPageListeners() {
    document.addEventListener('click', onClick, true);
    addEventListener('wheel', markUserScroll, { passive: true });
    addEventListener('touchmove', markUserScroll, { passive: true });
    addEventListener('pagehide', onPageHide);
  }
  function removePageListeners() {
    document.removeEventListener('click', onClick, true);
    removeEventListener('wheel', markUserScroll);
    removeEventListener('touchmove', markUserScroll);
    removeEventListener('pagehide', onPageHide);
  }

  // ---------------- messages ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.to !== 'content') return;
    if (msg.cmd) {
      if (msg.cmd === 'toggle') {
        if (active) togglePause(); else start('auto');
      } else {
        start(msg.cmd); // 'page' | 'selection'
      }
      sendResponse({ ok: true });
      return;
    }
    if (!active) return;
    switch (msg.event) {
      case 'sentence':
        cur = msg.idx;
        highlightSentence(cur);
        if (playing) setStatus(`${cur + 1} / ${doc.sentences.length}`);
        break;
      case 'word':
        if (msg.idx === cur) highlightWord(msg.idx, msg.start, msg.length);
        break;
      case 'state':
        if (msg.state === 'buffering' && playing) setStatus('Loading…');
        if (msg.state === 'playing') { playing = true; setPlayIcon(true); setStatus(`${cur + 1} / ${doc.sentences.length}`); }
        break;
      case 'error':
        onError(msg.message);
        break;
      case 'end':
      case 'stopped':
        stop(false);
        break;
      default:
    }
  });
})();
