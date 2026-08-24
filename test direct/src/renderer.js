'use strict';

/* ============================ Theme ============================ */
// Two themes: "dark" (default) and "glass" (translucent, Apple-style).
// Persisted in localStorage and applied by toggling .theme-glass on <body>.
const THEME_KEY = 'ruleflow-theme';

function applyTheme(theme) {
  document.body.classList.toggle('theme-glass', theme === 'glass');
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.setAttribute('aria-checked', theme === 'glass');
    btn.title = theme === 'glass' ? 'Переключить на тёмную тему' : 'Переключить на прозрачную тему';
  }
  try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
}

function initTheme() {
  let theme = 'dark';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'glass' || saved === 'dark') theme = saved;
  } catch (_) {}
  applyTheme(theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const next = document.body.classList.contains('theme-glass') ? 'dark' : 'glass';
      applyTheme(next);
      // LiquidGlass refraction (src/liquidglass.js) engages only while the
      // glass theme is active; re-scan / tear down on each user toggle. The
      // boot-time scan happens once in LiquidGlass.init() below, so a saved
      // glass theme isn't scanned twice at startup.
      if (window.LiquidGlass) window.LiquidGlass.refresh();
    });
  }
}

initTheme();

// LiquidGlass refraction engine: start it once the DOM is parsed (script is at
// the end of <body>). It gates itself on the glass theme being active.
if (window.LiquidGlass) window.LiquidGlass.init();

/* ============================ State ============================ */
const state = {
  rules: [],            // { id, type, value, section? }
  geositeMeta: [],      // [{ code, count }]
  geositeCache: {},     // code -> [{ type, value }]
  geoipMeta: [],        // [{ code, count }]
  addedKeys: new Set(), // normalized keys currently present in rules
  importedJson: null,   // original JSON object from last import (for round-trip export)
  currentSection: 'Direct',
  geositeSource: null,  // url or local filename last loaded in Geosite column
  geoipSource: null     // url or local filename last loaded in GeoIP column
};
let ruleSeq = 1;
let draggingId = null;   // internal reorder

/* ======================= Rule persistence ======================= */
// Rules used to live only in memory: closing the window — or a crash — threw
// away the whole session, and a replace-import that parsed to nothing was
// unrecoverable. Saved debounced so bulk imports don't serialize per rule.
const RULES_KEY = 'ruleflow-rules';
const RULES_SAVE_MAX = 20000;   // beyond this, localStorage quota is the real limit
let saveTimer = null;
let saveDirty = false;          // a mutation happened since the last real save
let restoring = false;          // suppress saves while loading the saved set

// Session snapshot held in memory after boot. Nothing is restored into the UI
// automatically: the user gets a timed "Восстановить сессию?" offer instead,
// and declining wipes the stored data for a clean start.
let pendingSession = null;

function saveRulesNow() {
  if (restoring) return;
  try {
    if (state.rules.length > RULES_SAVE_MAX) return;   // keep the last good snapshot
    const gfGeosite = gfState.cats.geosite.map((c) => ({ code: c.code, items: c.items }));
    const gfGeoip = gfState.cats.geoip.map((c) => ({ code: c.code, items: c.items }));
    const hasGfCats = gfGeosite.length > 0 || gfGeoip.length > 0;
    // An all-empty state is ambiguous: it's either "fresh app, nothing ever
    // happened" (must NOT overwrite a stored session) or "the user deleted
    // everything on purpose" (must overwrite, or the deleted rules resurrect
    // via the restore banner). saveDirty marks the second case.
    if (!state.rules.length && !hasGfCats && !state.importedJson) {
      if (saveDirty) {
        localStorage.removeItem(RULES_KEY);   // tombstone: deliberate empty
        saveDirty = false;
      }
      return;
    }
    saveDirty = false;
    localStorage.setItem(RULES_KEY, JSON.stringify({
      v: 1,
      section: state.currentSection,
      rules: state.rules.map((r) => ({ t: r.type, v: r.value, s: r.section })),
      importedJson: state.importedJson || null,
      // Geofiles tab: user-built categories survive restarts via the restore
      // offer. srcMeta/srcCache stay out — they're re-downloadable source data.
      gf: {
        mode: gfState.mode,
        selected: gfState.selected,
        geosite: gfGeosite,
        geoip: gfGeoip
      }
    }));
  } catch (_e) { /* quota or private mode — in-memory work continues */ }
}

function scheduleSave() {
  if (restoring) return;
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveRulesNow, 400);
}

// Boot: read what the last session saved into pendingSession — do NOT touch
// state/UI here. The restore banner decides whether it ever gets applied.
function loadSavedRules() {
  let data;
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (_e) { return; }
  if (!data || !Array.isArray(data.rules)) return;
  const valid = new Set(['Direct', 'Proxy', 'Block']);
  const rules = [];
  for (const r of data.rules) {
    if (!r || typeof r.t !== 'string' || typeof r.v !== 'string') continue;
    const value = r.v.trim();
    if (!value) continue;
    rules.push({
      type: r.t,
      value,
      section: valid.has(r.s) ? r.s : 'Direct'
    });
  }
  // Nothing worth offering? Skip the banner and clear storage right away.
  const hasGfCats = data.gf && (
    (Array.isArray(data.gf.geosite) && data.gf.geosite.length) ||
    (Array.isArray(data.gf.geoip) && data.gf.geoip.length)
  );
  if (!rules.length && !hasGfCats) {
    try { localStorage.removeItem(RULES_KEY); } catch (_) {}
    return;
  }
  pendingSession = {
    rules,
    section: valid.has(data.section) ? data.section : 'Direct',
    importedJson: (data.importedJson && typeof data.importedJson === 'object')
      ? data.importedJson : null,
    gf: hasGfCats ? {
      mode: data.gf.mode === 'geoip' ? 'geoip' : 'geosite',
      selected: typeof data.gf.selected === 'string' ? data.gf.selected : null,
      geosite: Array.isArray(data.gf.geosite) ? data.gf.geosite : [],
      geoip: Array.isArray(data.gf.geoip) ? data.gf.geoip : []
    } : null
  };
}

// Apply pendingSession to the live UI. Called only from the banner button.
function applyPendingSession() {
  if (!pendingSession) return false;
  restoring = true;
  try {
    state.rules = [];
    state.addedKeys.clear();
    rulesList.innerHTML = '';
    ruleSeq = 1;
    for (const p of pendingSession.rules) {
      state.rules.push({ id: ruleSeq++, type: p.type, value: p.value, section: p.section });
    }
    state.currentSection = pendingSession.section;
    // The markup's active tab is whatever was hard-coded; sync it to the
    // restored section so the highlight matches the rules on screen.
    document.querySelectorAll('#view-editor .section-tab').forEach((t) => {
      t.classList.toggle('active', t.dataset.section === state.currentSection);
    });
    state.importedJson = pendingSession.importedJson;

    if (pendingSession.gf) {
      gfState.mode = pendingSession.gf.mode;
      gfState.cats.geosite = pendingSession.gf.geosite.filter(
        (c) => c && typeof c.code === 'string' && Array.isArray(c.items));
      gfState.cats.geoip = pendingSession.gf.geoip.filter(
        (c) => c && typeof c.code === 'string' && Array.isArray(c.items));
      gfState.selected = pendingSession.gf.selected;
      document.querySelectorAll('.gf-subtab').forEach((t) => {
        t.classList.toggle('active', t.dataset.gf === gfState.mode);
      });
      gfRenderTree();
      gfRenderCatList();
      gfRenderCatContent();
    }
  } finally {
    restoring = false;
  }
  refreshAddedKeys();
  renderRulesList();
  updateRulesCount();
  syncMarks();
  scheduleSave();
  return true;
}

// User ignored / dismissed the offer: wipe stored data so the next launch
// starts clean instead of re-offering a stale session forever.
function discardPendingSession() {
  pendingSession = null;
  try { localStorage.removeItem(RULES_KEY); } catch (_) {}
}

/* ============================ Helpers ============================ */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

// Identity of a rule *within one section*. The UI marks tiles per the section
// being edited, so a section-less key would make geosite:CN in Direct and in
// Proxy collide: adding one would report "already exists", and toggling the
// tile in Direct would delete the Proxy rule instead.
function ruleKey(type, value) {
  return type + ':' + String(value).trim().toLowerCase();
}
function sectionKey(section, type, value) {
  return section + '|' + ruleKey(type, value);
}
function formatRule(r) {
  return r.type === 'plain' ? r.value : r.type + ':' + r.value;
}
// Section headers in exported .txt — a comment to anything that doesn't know
// about them, a section switch to us.
const SECTION_HEADER_PREFIX = '# [';
const SECTION_HEADER_RE = /^#\s*\[(Direct|Proxy|Block)\]\s*$/i;
const SECTION_NAMES = { direct: 'Direct', proxy: 'Proxy', block: 'Block' };

function parseLine(line) {
  const t = line.trim();
  if (!t) return null;
  if (t.startsWith('#')) {
    const h = SECTION_HEADER_RE.exec(t);
    // Signals a switch rather than a rule; the caller applies it to what follows.
    return h ? { header: SECTION_NAMES[h[1].toLowerCase()] } : null;
  }
  const m = /^(domain|geosite|geoip|regexp|keyword):(.+)$/i.exec(t);
  if (m) return { type: m[1].toLowerCase(), value: m[2].trim() };
  return { type: 'plain', value: t };
}

function parseJsonImport(obj) {
  const sectionMap = {
    DirectSites: 'Direct', DirectIp: 'Direct',
    ProxySites: 'Proxy', ProxyIp: 'Proxy',
    BlockSites: 'Block', BlockIp: 'Block'
  };
  const result = [];
  for (const [key, section] of Object.entries(sectionMap)) {
    const arr = obj[key];
    if (!Array.isArray(arr)) continue;
    for (const entry of arr) {
      const p = parseLine(String(entry));
      // Each JSON array already carries its section, so a stray `# [...]`
      // header line inside one is meaningless here — and has no .value.
      if (p && !p.header && p.value.trim()) {
        p.section = section;
        result.push(p);
      }
    }
  }
  return result;
}

function tryParseJson(text) {
  try { return JSON.parse(text.trim().replace(/^\ufeff/, '')); } catch (_) { return null; }
}

function toast(msg, kind, duration) {
  const wrap = $('#toast-wrap');
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 250);
  }, duration || 2200);
}

/* ============================ App tabs ============================ */
document.querySelectorAll('.app-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $('#view-editor').hidden = view !== 'editor';
    $('#view-converter').hidden = view !== 'converter';
    $('#view-geofiles').hidden = view !== 'geofiles';
    if (view === 'converter') {
      renderConvSrcList();
      updateConvTabCounts();
    } else if (view === 'geofiles') {
      gfRenderTree();
      gfRenderCatList();
      gfRenderCatContent();
    }
    helpSyncToView(view);
  });
});

/* ============================ Help / notes modal ============================ */
/* One note per app tab (editor/converter/geofiles), persisted in localStorage.
   Users see a read-only view. The maintainer enters edit mode by clicking "?"
   5 times within 2 seconds (title shows a hint counter while clicking). */
const helpModal = $('#help-modal');
const helpViewEl = $('#help-notes');
const helpEditEl = $('#help-edit');
const helpTitle = $('#help-title');
const helpSaved = $('#help-saved');
const HELP_TITLES = { editor: 'Заметки — Редактор', converter: 'Заметки — Конвертер', geofiles: 'Заметки — Geofiles' };
let helpView = 'editor';
let helpSaveTimer = null;
let helpClicks = [];
let helpEditing = false;

function helpLoad() {
  let notes = {};
  try { notes = JSON.parse(localStorage.getItem('ruleflow-help-notes') || '{}'); } catch (e) { notes = {}; }
  return notes;
}

function helpSyncToView(view) {
  helpView = view;
  if (helpModal.hidden) return;
  helpTitle.textContent = HELP_TITLES[view] || 'Заметки';
  const text = helpLoad()[view] || '';
  helpViewEl.textContent = text;
  helpEditEl.value = text;
  helpSaved.classList.remove('show');
}

function helpOpen() {
  helpModal.hidden = false;   // unhide first: helpSyncToView early-returns while hidden
  helpSyncToView(helpView);
}
function helpClose() {
  helpPersist();              // persist first: helpToggleEdit(false) clears helpEditing
  if (helpEditing) helpToggleEdit(false);
  helpModal.hidden = true;
  helpClicks = [];
}

function helpToggleEdit(on) {
  helpEditing = on !== undefined ? on : !helpEditing;
  if (helpEditing) {
    helpEditEl.hidden = false;
    helpViewEl.hidden = true;
    helpEditEl.value = helpLoad()[helpView] || '';
    helpTitle.textContent = (HELP_TITLES[helpView] || 'Заметки') + ' — редактирование';
    helpEditEl.focus();
  } else {
    helpEditEl.hidden = true;
    helpViewEl.hidden = false;
    helpViewEl.textContent = helpEditEl.value;
    helpTitle.textContent = HELP_TITLES[helpView] || 'Заметки';
  }
}

$('#help-btn').addEventListener('click', () => {
  const now = Date.now();
  helpClicks = helpClicks.filter((t) => now - t < 2000);
  helpClicks.push(now);
  // 5 clicks within 2s = maintainer edit mode. Counted regardless of the
  // open/close toggle so rapid clicking never closes the modal mid-sequence.
  if (helpClicks.length >= 5) {
    helpClicks = [];
    if (helpEditing) { helpClose(); return; }
    helpModal.hidden = false;   // unhide first: helpSyncToView early-returns while hidden
    helpSyncToView(helpView);
    helpToggleEdit(true);
    toast('Режим редактирования заметок включён', 'ok');
    return;
  }
  if (helpModal.hidden) {
    helpModal.hidden = false;   // unhide first: helpSyncToView early-returns while hidden
    helpSyncToView(helpView);
    helpViewEl.scrollTop = 0;   // fresh open: read from the top
  }
});
$('#help-close').addEventListener('click', helpClose);
helpModal.addEventListener('click', (e) => { if (e.target === helpModal) helpClose(); });

function helpPersist() {
  if (!helpEditing) return;
  const notes = helpLoad();
  notes[helpView] = helpEditEl.value;
  try { localStorage.setItem('ruleflow-help-notes', JSON.stringify(notes)); } catch (e) { /* quota */ }
  helpSaved.textContent = 'Сохранено';
  helpSaved.classList.add('show');
  clearTimeout(helpSaveTimer);
  helpSaveTimer = setTimeout(() => helpSaved.classList.remove('show'), 1600);
}

// Debounced autosave while typing; Ctrl+Enter saves and exits edit mode.
helpEditEl.addEventListener('input', () => {
  clearTimeout(helpSaveTimer);
  helpSaveTimer = setTimeout(helpPersist, 600);
});
helpEditEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    helpPersist();
    helpToggleEdit(false);
  }
});

/* ============================ Converter ============================ */
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+(\/\d{1,3})?$/i;

// Converter export order: regexp -> keyword -> plain -> domain (stable).
const SITE_TYPE_ORDER = { regexp: 0, keyword: 1, plain: 2, domain: 3 };

function siteType(line) {
  const m = /^(regexp|keyword|domain):/i.exec(line);
  return m ? m[1].toLowerCase() : 'plain';
}

function convertDomainType(type, value) {
  if (IP_RE.test(value.trim())) return value.trim();
  if (type === 'regex') return 'regexp:' + value;
  return 'domain:' + value;
}

async function buildConvertedJson() {
  const json = state.importedJson ? JSON.parse(JSON.stringify(state.importedJson)) : {};
  const skipped = { geosite: [], geoip: [] };
  for (const section of ['Direct', 'Proxy', 'Block']) {
    const sites = [], ips = [];
    const seen = new Set();
    const push = (line, arr) => {
      const key = String(line).trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      arr.push(line);
    };
    for (const r of state.rules) {
      if ((r.section || 'Direct') !== section) continue;
      if (r.type === 'geosite') {
        const domains = state.geositeCache[r.value] || await window.api.geositeDomains(r.value);
        if (!domains.length) { skipped.geosite.push(r.value); continue; } // категории нет в .dat — удаляем
        state.geositeCache[r.value] = domains;
        domains.forEach((d) => push(convertDomainType(d.type, d.value), sites));
      } else if (r.type === 'geoip') {
        const cidrs = await window.api.geoipCidrs(r.value);
        if (!cidrs.length) { skipped.geoip.push(r.value); continue; } // страны нет в .dat — удаляем
        cidrs.forEach((c) => push(c, ips));
      } else {
        push(formatRule(r), sites);
      }
    }
    sites.sort((a, b) => SITE_TYPE_ORDER[siteType(a)] - SITE_TYPE_ORDER[siteType(b)]);
    json[section + 'Sites'] = sites;
    json[section + 'Ip'] = ips;
  }
  json.Geositeurl = $('#conv-new-geosite').value.trim() || json.Geositeurl || '';
  json.Geoipurl = $('#conv-new-geoip').value.trim() || json.Geoipurl || '';
  json.LastUpdated = String(Math.floor(Date.now() / 1000));
  state.convSkipped = skipped;
  return json;
}

function showConvStats(before, after) {
  const stats = $('#conv-stats');
  stats.innerHTML = '';
  const rows = el('div', 'conv-stats-grid');
  const accent = { Direct: 'blue', Proxy: 'purple', Block: 'red' };
  for (const s of ['Direct', 'Proxy', 'Block']) {
    const row = el('div', 'conv-stat-row stat-' + accent[s]);
    row.append(
      el('span', 'conv-stat-name', s),
      el('span', 'conv-stat-num', 'до: ' + before[s] + ''),
      el('span', 'conv-stat-num', 'после: ' + after[s] + '')
    );
    rows.appendChild(row);
  }
  stats.appendChild(rows);
}

let convertedJson = null;

function lineToType(line) {
  const m = /^(domain|geosite|geoip|regexp|keyword):(.+)$/i.exec(line);
  return m ? { type: m[1].toLowerCase(), value: m[2].trim() } : { type: 'plain', value: line };
}

function convRuleEl(type, value) {
  const li = el('li', 'rule');
  const tag = el('span', 'tag ' + type, type);
  const val = el('span', 'val', value);
  val.title = (type === 'plain' ? value : type + ':' + value);
  li.append(tag, val);
  return li;
}

const convSrcList = $('#conv-src-list');
const convResList = $('#conv-res-list');
let convSrcSection = 'Direct';
let convResSection = 'Direct';

function updateConvTabCounts() {
  const srcCounts = { Direct: 0, Proxy: 0, Block: 0 };
  state.rules.forEach((r) => srcCounts[r.section || 'Direct']++);
  const resCounts = { Direct: 0, Proxy: 0, Block: 0 };
  if (convertedJson) {
    ['Direct', 'Proxy', 'Block'].forEach((s) => {
      resCounts[s] = (convertedJson[s + 'Sites'] || []).length + (convertedJson[s + 'Ip'] || []).length;
    });
  }
  const groups = document.querySelectorAll('#view-converter .conv-section-tabs');
  if (groups.length < 2) return;
  groups[0].querySelectorAll('.section-tab').forEach((t) => {
    t.querySelector('.tab-count').textContent = srcCounts[t.dataset.section];
  });
  groups[1].querySelectorAll('.section-tab').forEach((t) => {
    t.querySelector('.tab-count').textContent = resCounts[t.dataset.section];
  });
}

function renderConvSrcList() {
  convSrcList.innerHTML = '';
  const list = state.rules.filter((r) => (r.section || 'Direct') === convSrcSection);
  $('#conv-src-count').textContent = state.rules.length;
  $('#conv-src-empty').style.display = list.length ? 'none' : 'block';
  const missing = new Set((state.convMissing && state.convMissing.geosite) || []);
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const li = convRuleEl(r.type, r.value);
    if (r.type === 'geosite' && missing.has(r.value)) li.classList.add('missing-cat');
    const del = el('button', 'del', '✕');
    del.title = 'Удалить';
    del.addEventListener('click', () => {
      removeRule(r.id);
      renderConvSrcList();
      updateConvTabCounts();
    });
    li.appendChild(del);
    frag.appendChild(li);
  }
  convSrcList.appendChild(frag);
}

/* Rules referencing a category that is absent from the currently loaded
   geosite .dat get a red outline; the first one is scrolled into view so the
   user immediately sees what will break on export/convert. */
function markMissingCategories() {
  state.convMissing = { geosite: [], geoip: [] };
  const gsCodes = new Set(state.geositeMeta.map((c) => c.code));
  const giCodes = new Set(state.geoipMeta.map((c) => c.code));
  for (const r of state.rules) {
    if (r.type === 'geosite' && !gsCodes.has(String(r.value).toUpperCase())) {
      if (!state.convMissing.geosite.includes(r.value)) state.convMissing.geosite.push(r.value);
    }
    if (r.type === 'geoip' && !giCodes.has(String(r.value).toUpperCase())) {
      if (!state.convMissing.geoip.includes(r.value)) state.convMissing.geoip.push(r.value);
    }
  }
  renderConvSrcList();
  renderRulesList();
  // jump to the first missing rule in the converter list
  const first = convSrcList.querySelector('.rule.missing-cat');
  if (first) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderConvResList(json) {
  convResList.innerHTML = '';
  const s = convResSection;
  const totalAll = ['Direct', 'Proxy', 'Block'].reduce((acc, sec) => {
    return acc + (json[sec + 'Sites'] || []).length + (json[sec + 'Ip'] || []).length;
  }, 0);
  let total = 0;
  const frag = document.createDocumentFragment();
  (json[s + 'Sites'] || []).forEach((l) => {
    const p = lineToType(l);
    frag.appendChild(convRuleEl(p.type, p.value));
    total++;
  });
  (json[s + 'Ip'] || []).forEach((l) => {
    const p = lineToType(l);
    frag.appendChild(convRuleEl(p.type, p.value));
    total++;
  });
  convResList.appendChild(frag);
  $('#conv-res-count').textContent = totalAll;
  $('#conv-res-empty').style.display = total ? 'none' : 'block';
  updateConvTabCounts();
}

const convSrcTabs = document.querySelectorAll('#view-converter .conv-section-tabs');
if (convSrcTabs.length >= 2) {
  convSrcTabs[0].querySelectorAll('.section-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      convSrcTabs[0].querySelectorAll('.section-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      convSrcSection = tab.dataset.section;
      renderConvSrcList();
    });
  });
  convSrcTabs[1].querySelectorAll('.section-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      convSrcTabs[1].querySelectorAll('.section-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      convResSection = tab.dataset.section;
      if (convertedJson) renderConvResList(convertedJson);
    });
  });
}

$('#conv-import').addEventListener('click', () => { importModal.hidden = false; });

$('#conv-export').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Нечего экспортировать', 'err');
  const content = state.rules.map(formatRule).join('\n') + '\n';
  try {
    const ok = await window.api.saveText({ defaultName: 'rules.txt', content });
    if (ok) toast('Экспортировано в файл', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

$('#conv-src-export-json').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Нечего экспортировать', 'err');
  const content = JSON.stringify(buildExportJson(), null, 2);
  try {
    const ok = await window.api.saveText({ defaultName: 'rules.json', content });
    if (ok) toast('Экспортировано в JSON', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

$('#conv-link-src-happ').addEventListener('click', () => copyRoutingLink('happ', 'Happ'));
$('#conv-link-src-incy').addEventListener('click', () => copyRoutingLink('incy', 'Incy'));

async function loadConvDat(kind) {
  const status = $('#conv-status');
  const isGeosite = kind === 'geosite';
  const url = (isGeosite ? $('#conv-src-geosite') : $('#conv-src-geoip')).value.trim();
  status.className = 'status';
  status.innerHTML = 'Загрузка ' + kind + ' <span class="spin">⟳</span>';
  try {
    let payload;
    if (/^https?:\/\//i.test(url)) payload = { url };
    else {
      const f = await window.api.openFile({ filters: [{ name: (isGeosite ? 'Geosite' : 'GeoIP') + ' dat', extensions: ['dat'] }] });
      if (!f) { status.textContent = ''; return false; }
      payload = { fileData: f.data };
      if (isGeosite) state.geositeSource = f.path.split('\\').pop();
      else state.geoipSource = f.path.split('\\').pop();
    }
    const res = isGeosite
      ? await window.api.geositeLoad(payload)
      : await window.api.geoipLoad(payload);
    if (isGeosite) {
      state.geositeMeta = res.categories;
      state.geositeCache = {};
      if (/^https?:\/\//i.test(url)) state.geositeSource = url;
      status.className = 'status ok';
      status.textContent = `Geosite загружен — категорий: ${res.categories.length}`;
    } else {
      state.geoipMeta = res.countries;
      if (/^https?:\/\//i.test(url)) state.geoipSource = url;
      status.className = 'status ok';
      status.textContent = `GeoIP загружен — стран: ${res.countries.length}`;
    }
    return true;
  } catch (err) {
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
    return false;
  }
}

$('#conv-load-dats').addEventListener('click', async () => {
  await loadConvDat('geosite');
  await loadConvDat('geoip');
});

$('#conv-file-geosite').addEventListener('click', () => {
  $('#conv-src-geosite').value = '';
  loadConvDat('geosite');
});

$('#conv-file-geoip').addEventListener('click', () => {
  $('#conv-src-geoip').value = '';
  loadConvDat('geoip');
});

$('#conv-run').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Сначала добавьте правила в редакторе', 'err');
  const needGeosite = state.rules.some((r) => r.type === 'geosite');
  const needGeoip = state.rules.some((r) => r.type === 'geoip');
  if (needGeosite && !state.geositeMeta.length) {
    if (!$('#conv-src-geosite').value.trim()) return toast('Укажите URL или загрузите файл geosite.dat', 'err');
    const ok = await loadConvDat('geosite');
    if (!ok) return;
  }
  if (needGeoip && !state.geoipMeta.length) {
    if (!$('#conv-src-geoip').value.trim()) return toast('Укажите URL или загрузите файл geoip.dat', 'err');
    const ok = await loadConvDat('geoip');
    if (!ok) return;
  }
  // Pre-convert validation: every geosite:/geoip: rule must exist in the
  // loaded .dat files. Missing ones are highlighted red, the list scrolls to
  // the first offender, and conversion is blocked with a how-to-fix toast.
  markMissingCategories();
  const mg = state.convMissing.geosite, mi = state.convMissing.geoip;
  if (mg.length || mi.length) {
    const parts = [];
    mg.slice(0, 3).forEach((c) => parts.push('geosite:' + c + ' есть в ваших правилах, но его нету в указанном geosite. Добавьте в ваш geosite - geosite:' + c));
    mi.slice(0, 3).forEach((c) => parts.push('geoip:' + c + ' есть в ваших правилах, но его нету в указанном geoip. Добавьте в ваш geoip - geoip:' + c));
    if (mg.length > 3 || mi.length > 3) parts.push('…и ещё ' + Math.max(0, mg.length - 3) + (mi.length ? ' / ' + mi.length : ''));
    toast(parts.join('\n'), 'err', 8000);
    return;
  }
  const before = { Direct: 0, Proxy: 0, Block: 0 };
  state.rules.forEach((r) => before[r.section || 'Direct']++);
  const json = await buildConvertedJson();
  convertedJson = json;
  const after = {};
  ['Direct', 'Proxy', 'Block'].forEach((s) => {
    after[s] = (json[s + 'Sites'] || []).length + (json[s + 'Ip'] || []).length;
  });
  showConvStats(before, after);
  const total = Object.values(after).reduce((a, b) => a + b, 0);
  renderConvResList(json);
  const skipped = state.convSkipped || { geosite: [], geoip: [] };
  const warn = [];
  if (skipped.geosite.length) warn.push('geosite: ' + skipped.geosite.join(', '));
  if (skipped.geoip.length) warn.push('geoip: ' + skipped.geoip.join(', '));
  if (warn.length) {
    toast('Конвертировано: ' + total + '. Не найдены в .dat: ' + warn.join('; '), 'err');
  } else {
    toast('Конвертировано правил: ' + total, 'ok');
  }
});

$('#conv-export-txt').addEventListener('click', async () => {
  if (!convertedJson) return toast('Сначала нажмите «Конвертировать»', 'err');
  const lines = [];
  ['Direct', 'Proxy', 'Block'].forEach((s) => {
    (convertedJson[s + 'Sites'] || []).forEach((l) => lines.push(l));
    (convertedJson[s + 'Ip'] || []).forEach((l) => lines.push(l));
  });
  try {
    const ok = await window.api.saveText({ defaultName: 'converted-rules.txt', content: lines.join('\n') + '\n' });
    if (ok) toast('Экспортировано в файл', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

$('#conv-export-json').addEventListener('click', async () => {
  if (!convertedJson) return toast('Сначала нажмите «Конвертировать»', 'err');
  try {
    const ok = await window.api.saveText({ defaultName: 'converted-rules.json', content: JSON.stringify(convertedJson, null, 2) });
    if (ok) toast('Экспортировано в JSON', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

$('#conv-link-happ').addEventListener('click', () => copyRoutingJson('happ', 'Happ'));
$('#conv-link-incy').addEventListener('click', () => copyRoutingJson('incy', 'Incy'));

async function copyRoutingJson(scheme, label) {
  if (!convertedJson) return toast('Сначала нажмите «Конвертировать»', 'err');
  try {
    const link = scheme + '://routing/onadd/' + utf8ToBase64(JSON.stringify(convertedJson));
    await window.api.clipboardWrite(link);
    toast(label + '-ссылка скопирована в буфер', 'ok');
  } catch (err) {
    toast('Ошибка: ' + err.message, 'err');
  }
}

/* ============================ Rules column ============================ */
const rulesList = $('#rules-list');

// Marks reflect the section on screen, so this set holds the current section's
// keys only. Tiles compare against a plain ruleKey (dataset.key), which keeps
// syncMarks() unchanged while Direct/Proxy/Block stay independent.
function refreshAddedKeys() {
  state.addedKeys = new Set(
    state.rules
      .filter((r) => r.section === state.currentSection)
      .map((r) => ruleKey(r.type, r.value))
  );
}

// Does `value` already exist in `section`? Used instead of addedKeys whenever
// the target section may differ from the one being displayed.
function hasRuleIn(section, type, value) {
  const k = ruleKey(type, value);
  return state.rules.some((r) => r.section === section && ruleKey(r.type, r.value) === k);
}

function syncMarks() {
  // geosite rows: recompute section tints (categories + domain rows)
  document.querySelectorAll('#geosite-tree .cat').forEach((c) => {
    applySectionTint(c, 'geosite', c.dataset.code || '',
      c.querySelector('.cat-add'));
  });
  document.querySelectorAll('#geosite-tree .dom').forEach((d) => {
    const val = d.querySelector('.val');
    if (val && d.dataset.key) {
      const keyParts = d.dataset.key.split(':');
      const type = keyParts[0];
      const value = keyParts.slice(1).join(':');
      applySectionTint(d, type === 'plain' ? 'plain' : type, value, null);
    }
  });
  // geoip tiles
  document.querySelectorAll('.tile').forEach((t) => {
    t.classList.toggle('added', state.addedKeys.has(t.dataset.key));
  });
}

function updateRulesCount() {
  const count = state.rules.filter(r => r.section === state.currentSection).length;
  $('#rules-count').textContent = count;
  $('#rules-empty').style.display = count ? 'none' : 'block';
  // update editor tab badges only — converter tabs own their counts
  document.querySelectorAll('#view-editor .section-tab').forEach((tab) => {
    const s = tab.dataset.section;
    const c = state.rules.filter(r => r.section === s).length;
    const badge = tab.querySelector('.tab-count') || el('span', 'tab-count', c);
    if (!tab.querySelector('.tab-count')) tab.appendChild(badge);
    badge.textContent = c;
  });
}

function addRule(type, value, opts = {}) {
  value = String(value).trim();
  if (!value) return null;
  const section = opts.section || state.currentSection;
  const key = ruleKey(type, value);
  // Duplicate only when the same value already sits in the SAME section.
  if (hasRuleIn(section, type, value)) {
    // already exists — flash it (only visible when it's the displayed section)
    const existing = [...rulesList.children].find((c) => c._key === key);
    if (existing) {
      existing.classList.remove('flash');
      void existing.offsetWidth;
      existing.classList.add('flash');
      existing.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    if (!opts.silent) toast('Правило уже есть', 'err');
    return null;
  }
  const rule = { id: ruleSeq++, type, value, section };
  state.rules.push(rule);
  if (section === state.currentSection) state.addedKeys.add(key);
  if (rule.section === state.currentSection) {
    const node = createRuleEl(rule);
    rulesList.appendChild(node);
    if (opts.flash) node.classList.add('flash');
  }
  updateRulesCount();
  if (!opts.batch) syncMarks();
  scheduleSave();
  if (type === 'geosite') dedupeGeosite(value, section);
  return rule;
}

// Adding geosite:CN makes individual domain rules it already covers redundant —
// but only inside the SAME section: a domain routed via Proxy is not made
// redundant by a Direct geosite rule.
async function dedupeGeosite(catCode, section = state.currentSection) {
  let domains = state.geositeCache[catCode];
  if (!domains) {
    try {
      domains = await window.api.geositeDomains(catCode);
    } catch (_) { return; }
    if (!domains) return;
  }
  const vals = new Set(
    domains
      .filter((d) => d.type !== 'regex')
      .map((d) => String(d.value).trim().toLowerCase())
  );
  const dupes = state.rules.filter(
    (r) => r.section === section && r.type === 'domain' && vals.has(r.value.trim().toLowerCase())
  );
  if (!dupes.length) return;
  dupes.forEach((r) => removeRule(r.id));
  toast('Удалено дублей под geosite:' + catCode + ': ' + dupes.length, 'ok');
}

function removeRule(id) {
  const idx = state.rules.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const rule = state.rules[idx];
  state.rules.splice(idx, 1);
  // Only drop the mark when no rule with that key remains in the shown section.
  if (rule.section === state.currentSection
      && !hasRuleIn(state.currentSection, rule.type, rule.value)) {
    state.addedKeys.delete(ruleKey(rule.type, rule.value));
  }
  const node = [...rulesList.children].find((c) => c._id === id);
  if (node) {
    node.classList.add('removing');
    setTimeout(() => node.remove(), 270);
  }
  updateRulesCount();
  setTimeout(syncMarks, 0);
  scheduleSave();
}

function renderRulesList() {
  rulesList.innerHTML = '';
  const missing = new Set((state.convMissing && state.convMissing.geosite) || []);
  const frag = document.createDocumentFragment();
  for (const r of state.rules) {
    if (r.section === state.currentSection) {
      const el = createRuleEl(r);
      if (r.type === 'geosite' && missing.has(r.value)) el.classList.add('missing-cat');
      el.classList.add('new-batch');
      // Cross-section badges: show which OTHER sections hold the same value,
      // so no tab-switching is needed to see the full picture.
      const others = state.rules.filter(
        (x) => x.id !== r.id && x.section !== r.section
          && ruleKey(x.type, x.value) === ruleKey(r.type, r.value)
      );
      for (const o of others) {
        el.classList.add('also-' + o.section.toLowerCase());
        el.appendChild(makeCrossBadge(o));
      }
      frag.appendChild(el);
    }
  }
  rulesList.appendChild(frag);
  requestAnimationFrame(() => {
    document.querySelectorAll('.rule.new-batch').forEach((n) => n.classList.remove('new-batch'));
  });
}

// Small colored chip on a rule row: "this value also exists in <section>".
// Clicking it removes that other-section copy right from here.
function makeCrossBadge(targetRule) {
  const section = targetRule.section;
  const b = el('button', 'cross-badge badge-' + section.toLowerCase(), section);
  b.title = 'Также есть в ' + section + ' — нажмите, чтобы удалить оттуда';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    removeRule(targetRule.id);
    toast('Удалено из ' + section, 'ok');
  });
  return b;
}

function createRuleEl(rule) {
  const li = el('li', 'rule');
  li._id = rule.id;
  li._key = ruleKey(rule.type, rule.value);
  li.draggable = true;

  const grip = el('span', 'grip', '⠿');
  const tag = el('span', 'tag ' + rule.type, rule.type);
  const val = el('span', 'val', rule.value);
  val.title = formatRule(rule);
  const del = el('button', 'del', '✕');
  del.title = 'Удалить';

  li.append(grip, tag, val, del);

  del.addEventListener('click', (e) => { e.stopPropagation(); removeRule(rule.id); });

  // inline edit
  val.addEventListener('click', () => startEdit(li, rule, val));

  // drag reorder
  li.addEventListener('dragstart', (e) => {
    draggingId = rule.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', formatRule(rule)); } catch (_) {}
  });
  li.addEventListener('dragend', () => {
    draggingId = null;
    li.classList.remove('dragging');
    document.querySelectorAll('.rule.drag-over').forEach((n) => n.classList.remove('drag-over'));
  });
  li.addEventListener('dragover', (e) => {
    if (draggingId == null || draggingId === rule.id) return;
    e.preventDefault();
    const rect = li.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    li.classList.toggle('drag-over', true);
    li._after = after;
  });
  li.addEventListener('dragleave', () => li.classList.remove('drag-over'));
  li.addEventListener('drop', (e) => {
    if (draggingId == null) return;
    e.preventDefault();
    e.stopPropagation();
    li.classList.remove('drag-over');
    reorderRule(draggingId, rule.id, li._after);
  });

  return li;
}

function reorderRule(fromId, toId, after) {
  if (fromId === toId) return;
  const arr = state.rules;
  const fromIdx = arr.findIndex((r) => r.id === fromId);
  const moved = arr.splice(fromIdx, 1)[0];
  let toIdx = arr.findIndex((r) => r.id === toId);
  if (after) toIdx += 1;
  arr.splice(toIdx, 0, moved);
  // re-render order in DOM — only current section's visible nodes
  const section = state.currentSection;
  const nodes = new Map([...rulesList.children].map((c) => [c._id, c]));
  arr.filter((r) => r.section === section).forEach((r) => rulesList.appendChild(nodes.get(r.id)));
  scheduleSave();   // order is part of the document
}

function startEdit(li, rule, val) {
  if (li.querySelector('.val-edit')) return;
  const input = el('input', 'val-edit');
  input.type = 'text';
  input.value = rule.value;
  val.replaceWith(input);
  input.focus();
  input.select();
  const commit = (save) => {
    const nv = input.value.trim();
    if (save && nv && nv !== rule.value) {
      // Renaming onto a value that already exists in this section would leave
      // two rules sharing one key and desync addedKeys for good — refuse it and
      // keep the original value.
      if (hasRuleIn(rule.section, rule.type, nv)) {
        toast('Правило ' + rule.type + ':' + nv + ' уже есть в этой секции', 'err');
      } else {
        rule.value = nv;
        li._key = ruleKey(rule.type, rule.value);
        refreshAddedKeys();
        syncMarks();
        scheduleSave();
      }
    }
    const newVal = el('span', 'val', rule.value);
    newVal.title = formatRule(rule);
    newVal.addEventListener('click', () => startEdit(li, rule, newVal));
    input.replaceWith(newVal);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit(true);
    else if (e.key === 'Escape') commit(false);
  });
  input.addEventListener('blur', () => commit(true));
}

/* external drop target (rules column) */
const colRules = $('#col-rules');
colRules.addEventListener('dragover', (e) => {
  if (draggingId != null) return; // internal handled per-row
  if (e.dataTransfer.types.includes('application/x-rule')) {
    e.preventDefault();
    colRules.classList.add('drop-target');
  }
});
colRules.addEventListener('dragleave', (e) => {
  if (!colRules.contains(e.relatedTarget)) colRules.classList.remove('drop-target');
});
colRules.addEventListener('drop', (e) => {
  colRules.classList.remove('drop-target');
  const raw = e.dataTransfer.getData('application/x-rule');
  if (!raw) return;
  e.preventDefault();
  try {
    const items = JSON.parse(raw); // array of {type,value}
    let n = 0;
    items.forEach((it) => { if (addRule(it.type, it.value, { flash: true, batch: true })) n++; });
    syncMarks();
    if (n) toast(`Добавлено: ${n}`, 'ok');
  } catch (_) {}
});

/* quick add */
$('#qa-add').addEventListener('click', quickAdd);
$('#qa-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickAdd(); });
function quickAdd() {
  const type = $('#qa-type').value;
  const v = $('#qa-input').value;
  if (!v.trim()) return;
  const r = addRule(type, v, { flash: true });
  if (r) { $('#qa-input').value = ''; toast('Добавлено', 'ok'); }
  $('#qa-input').focus();
}

/* export */
$('#btn-export').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Нечего экспортировать', 'err');
  // Group under section headers so the file round-trips. The headers are `#`
  // comments: older importers (and other tools) skip them as before, while our
  // parseLine picks them up and restores each rule to its own section.
  const order = ['Direct', 'Proxy', 'Block'];
  const sections = new Map(order.map((s) => [s, []]));
  for (const r of state.rules) {
    const s = sections.has(r.section) ? r.section : 'Direct';
    sections.get(s).push(formatRule(r));
  }
  const lines = [];
  for (const s of order) {
    const items = sections.get(s);
    if (!items.length) continue;
    if (lines.length) lines.push('');
    lines.push(SECTION_HEADER_PREFIX + s + ']');
    lines.push(...items);
  }
  const content = lines.join('\n') + '\n';
  try {
    const ok = await window.api.saveText({ defaultName: 'rules.txt', content });
    if (ok) toast('Экспортировано в файл', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

function buildExportJson() {
  const json = state.importedJson ? JSON.parse(JSON.stringify(state.importedJson)) : { DirectSites: [], DirectIp: [], ProxySites: [], ProxyIp: [], BlockSites: [], BlockIp: [] };
  json.DirectSites = []; json.DirectIp = [];
  json.ProxySites = []; json.ProxyIp = [];
  json.BlockSites = []; json.BlockIp = [];
  for (const r of state.rules) {
    const line = formatRule(r);
    const section = r.section || 'Direct';
    if (r.type === 'geoip') json[section + 'Ip'].push(line);
    else json[section + 'Sites'].push(line);
  }
  if (state.geositeSource) json.Geositeurl = state.geositeSource;
  if (state.geoipSource) json.Geoipurl = state.geoipSource;
  json.LastUpdated = String(Math.floor(Date.now() / 1000));
  return json;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function buildRoutingLink(scheme) {
  if (!state.rules.length) return null;
  const json = buildExportJson();
  return scheme + '://routing/onadd/' + utf8ToBase64(JSON.stringify(json));
}

async function copyRoutingLink(scheme, label) {
  const link = buildRoutingLink(scheme);
  if (!link) return toast('Нечего экспортировать', 'err');
  try {
    await window.api.clipboardWrite(link);
    toast(label + '-ссылка скопирована в буфер', 'ok');
  } catch (err) {
    toast('Ошибка: ' + err.message, 'err');
  }
}

$('#btn-link-happ').addEventListener('click', () => copyRoutingLink('happ', 'Happ'));
$('#btn-link-incy').addEventListener('click', () => copyRoutingLink('incy', 'Incy'));

$('#btn-export-json').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Нечего экспортировать', 'err');
  const content = JSON.stringify(buildExportJson(), null, 2);
  try {
    const ok = await window.api.saveText({ defaultName: 'rules.json', content });
    if (ok) toast('Экспортировано в JSON', 'ok');
  } catch (err) {
    toast('Ошибка сохранения: ' + err.message, 'err');
  }
});

/* ============================ Import modal ============================ */
const importModal = $('#import-modal');
$('#btn-import').addEventListener('click', () => { importModal.hidden = false; });
$('#import-cancel').addEventListener('click', () => { importModal.hidden = true; });
importModal.addEventListener('click', (e) => { if (e.target === importModal) importModal.hidden = true; });

document.querySelectorAll('.modal-tabs .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.modal-tabs .tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.querySelector(`.tab-pane[data-pane="${tab.dataset.tab}"]`).classList.add('active');
  });
});

$('#import-url-fetch').addEventListener('click', async () => {
  const url = $('#import-url').value.trim();
  if (!url) return;
  try {
    const text = await window.api.fetchText(url);
    $('#import-textarea').value = text;
    document.querySelector('.modal-tabs .tab[data-tab="text"]').click();
    toast('Загружено из URL — проверьте текст', 'ok');
  } catch (err) { toast('Ошибка URL: ' + err.message, 'err'); }
});

$('#import-file-pick').addEventListener('click', async () => {
  try {
    const text = await window.api.openText();
    if (text != null) {
      $('#import-textarea').value = text;
      document.querySelector('.modal-tabs .tab[data-tab="text"]').click();
      toast('Файл загружен — проверьте текст', 'ok');
    }
  } catch (err) {
    toast('Ошибка чтения файла: ' + err.message, 'err');
  }
});

function decodeRoutingLink(text) {
  let t = String(text).trim();
  try { t = decodeURIComponent(t); } catch (_) {} // ссылка могла быть URL-закодирована
  const marker = 'routing/onadd/';
  const idx = t.lastIndexOf(marker);
  if (idx >= 0) t = t.slice(idx + marker.length);
  t = t.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  if (!t) throw new Error('empty');
  const bin = atob(t);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function importRules(toAdd) {
  // Same ordering as the converter: regexp -> keyword -> plain -> domain (stable).
  toAdd.sort((a, b) => (SITE_TYPE_ORDER[a.type] ?? 99) - (SITE_TYPE_ORDER[b.type] ?? 99));
  let n = 0;
  const chunkSize = 500;
  const total = toAdd.length;
  try {
    for (let i = 0; i < total; i += chunkSize) {
      const end = Math.min(i + chunkSize, total);
      await new Promise((resolve) => {
        requestAnimationFrame(() => {
          const fragment = document.createDocumentFragment();
          for (let j = i; j < end; j++) {
            const p = toAdd[j];
            const rule = { id: ruleSeq++, type: p.type, value: p.value, section: p.section || state.currentSection };
            state.rules.push(rule);
            if (rule.section === state.currentSection) fragment.appendChild(createRuleEl(rule));
            n++;
          }
          rulesList.appendChild(fragment);
          resolve();
        });
      });
    }
    refreshAddedKeys();   // rules may have landed in the displayed section
    syncMarks();
    updateRulesCount();
    renderConvSrcList();
    updateConvTabCounts();
    saveRulesNow();   // bulk import: persist immediately, don't wait out the debounce
    // Don't dress up a no-op as success: 0 recognized rules is a failure the
    // user needs to see, especially right after a replace wiped the list.
    if (n === 0) {
      toast('Не распознано ни одного правила', 'err', 5000);
      return false;
    }
    toast(`Импортировано: ${n}`, 'ok');
    return true;
  } catch (err) {
    toast('Ошибка импорта: ' + err.message, 'err');
    return false;
  }
}

async function applyJsonImport(jsonObj) {
  state.importedJson = jsonObj;
  if (jsonObj.Geositeurl) $('#conv-src-geosite').value = jsonObj.Geositeurl;
  if (jsonObj.Geoipurl) $('#conv-src-geoip').value = jsonObj.Geoipurl;
  // The config's .dat sources apply everywhere, not just the converter: the
  // editor columns and the Geofiles source field all follow it, so categories
  // resolve against the same .dat the rules were built for.
  if (jsonObj.Geositeurl) {
    $('#geosite-url').value = jsonObj.Geositeurl;
    $('#gf-src-url').value = jsonObj.Geositeurl;
    state.geositeSource = jsonObj.Geositeurl;
  }
  if (jsonObj.Geoipurl) {
    $('#geoip-url').value = jsonObj.Geoipurl;
    state.geoipSource = jsonObj.Geoipurl;
  }
  const seen = new Set();
  // Section-aware: parseJsonImport tags each rule with its target section, so
  // the same value may legitimately land in Direct and Proxy both.
  const toAdd = parseJsonImport(jsonObj).filter((p) => {
    const section = p.section || state.currentSection;
    const key = sectionKey(section, p.type, p.value);
    if (seen.has(key) || hasRuleIn(section, p.type, p.value)) return false;
    seen.add(key);
    return true;
  });
  if (!toAdd.length) { toast('Не найдено правил в Direct секциях JSON', 'err'); return false; }
  return importRules(toAdd);
}

// Wipe the list only once we know the incoming data is usable. Clearing first
// meant a link/text that parsed to nothing left the user with an empty editor
// and no way back.
function clearAllRules() {
  state.rules = [];
  state.addedKeys.clear();
  rulesList.innerHTML = '';
  scheduleSave();
}

$('#import-apply').addEventListener('click', async () => {
  const replace = $('#import-replace').checked;
  const activeTab = document.querySelector('.modal-tabs .tab.active');
  const tab = activeTab ? activeTab.dataset.tab : 'text';

  if (tab === 'link') {
    const link = $('#import-link').value;
    if (!link.trim()) return toast('Вставьте ссылку', 'err');
    let jsonObj;
    try {
      jsonObj = decodeRoutingLink(link);
    } catch (_) {
      return toast('Не удалось распознать ссылку: битый base64 или не JSON', 'err');
    }
    if (!jsonObj || typeof jsonObj !== 'object' || Array.isArray(jsonObj)) {
      return toast('Не удалось распознать ссылку: не JSON-объект', 'err');
    }
    // Parsed and non-empty before anything is discarded.
    if (!parseJsonImport(jsonObj).length) {
      return toast('В ссылке не найдено правил — ничего не изменено', 'err', 5000);
    }
    if (replace) clearAllRules();
    const ok = await applyJsonImport(jsonObj);
    if (ok) importModal.hidden = true;
    return;
  }

  const text = $('#import-textarea').value;
  const jsonObj = tryParseJson(text);
  if (jsonObj && typeof jsonObj === 'object' && !Array.isArray(jsonObj)) {
    if (!parseJsonImport(jsonObj).length) {
      return toast('В JSON не найдено правил — ничего не изменено', 'err', 5000);
    }
    if (replace) clearAllRules();
    const ok = await applyJsonImport(jsonObj);
    if (ok) importModal.hidden = true;
    return;
  }

  // Parse the whole text first; only a non-empty result justifies a replace.
  // `# [Direct]`-style headers written by our own export switch the section for
  // everything that follows, so a file exported here comes back intact.
  const parsed = [];
  let target = state.currentSection;
  text.split(/\r?\n/).forEach((line) => {
    const p = parseLine(line);
    if (!p) return;
    if (p.header) { target = p.header; return; }
    if (!p.value.trim()) return;
    p.section = target;
    parsed.push(p);
  });
  if (!parsed.length) {
    return toast('Не распознано ни одного правила — ничего не изменено', 'err', 5000);
  }
  if (replace) clearAllRules();
  // Deduplicate against what's actually in the target section now.
  const seen = new Set();
  const toAdd = parsed.filter((p) => {
    const section = p.section || state.currentSection;
    const k = sectionKey(section, p.type, p.value);
    if (seen.has(k) || hasRuleIn(section, p.type, p.value)) return false;
    seen.add(k);
    return true;
  });
  if (!toAdd.length) {
    return toast('Все правила уже есть в списке', 'err', 4000);
  }
  const ok = await importRules(toAdd);
  if (ok) importModal.hidden = true;
});

/* ============================ Geosite column ============================ */
const geositeTree = $('#geosite-tree');

$('#geosite-load').addEventListener('click', loadGeosite);
$('#geosite-file').addEventListener('click', async () => {
  try {
    const f = await window.api.openFile({ filters: [{ name: 'Geosite dat', extensions: ['dat'] }] });
    if (!f) return;
    const res = await window.api.geositeLoad({ fileData: f.data });
    state.geositeMeta = res.categories;
    state.geositeCache = {};
    state.geositeSource = f.path.split('\\').pop();
    renderGeositeTree();
    const status = $('#geosite-status');
    status.className = 'status ok';
    status.textContent = `Загружен файл: ${f.path.split('\\').pop()} — категорий: ${res.categories.length}`;
  } catch (err) {
    const status = $('#geosite-status');
    status.className = 'status error';
    status.textContent = 'Ошибка чтения .dat: ' + err.message;
  }
});
$('#geosite-filter').addEventListener('input', renderGeositeTree);

let searchTimer = null;
$('#geosite-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runGeositeSearch, 220);
});

async function loadGeosite() {
  const url = $('#geosite-url').value.trim();
  const status = $('#geosite-status');
  status.className = 'status';
  status.innerHTML = 'Загрузка <span class="spin">⟳</span>';
  try {
    let payload;
    let f = null;
    if (/^https?:\/\//i.test(url)) payload = { url };
    else { // treat as local file path -> open dialog instead
      f = await window.api.openFile({ filters: [{ name: 'dat', extensions: ['dat'] }] });
      if (!f) { status.textContent = ''; return; }
      payload = { fileData: f.data };
    }
    const res = await window.api.geositeLoad(payload);
    state.geositeMeta = res.categories;
    state.geositeCache = {};
    state.geositeSource = /^https?:\/\//i.test(url) ? url : (f ? f.path.split('\\').pop() : url);
    renderGeositeTree();
    status.className = 'status ok';
    status.textContent = `Загружено категорий: ${res.categories.length}`;
  } catch (err) {
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
  }
}

function renderGeositeTree() {
  // Content-search takes over the tree when active.
  if ($('#geosite-search').value.trim()) { runGeositeSearch(); return; }
  const filter = $('#geosite-filter').value.trim().toUpperCase();
  geositeTree.innerHTML = '';
  const list = filter
    ? state.geositeMeta.filter((c) => c.code.includes(filter))
    : state.geositeMeta;
  for (const cat of list) geositeTree.appendChild(createCatEl(cat));
}

async function runGeositeSearch() {
  const q = $('#geosite-search').value.trim();
  const status = $('#geosite-status');
  if (!q) { renderGeositeTree(); return; }
  if (!state.geositeMeta.length) {
    status.className = 'status error';
    status.textContent = 'Сначала загрузите geosite.dat';
    return;
  }
  status.className = 'status';
  status.innerHTML = 'Поиск <span class="spin">⟳</span>';
  const results = await window.api.geositeSearch(q);
  geositeTree.innerHTML = '';
  if (!results.length) {
    status.className = 'status';
    status.textContent = `По «${q}» ничего не найдено`;
    return;
  }
  let totalHits = 0;
  for (const r of results) {
    totalHits += r.matches.length;
    geositeTree.appendChild(createCatEl({ code: r.code, count: r.total }, { matches: r.matches, query: q }));
  }
  status.className = 'status ok';
  status.textContent = `Найдено: ${totalHits} доменов в ${results.length} категориях`;
}

// Section tinting for the geosite tree: marks the element with
// in-direct / in-proxy / in-block classes based on where the value currently
// exists. Works from ANY active tab — that's the whole point: no need to hop
// between Direct/Proxy/Block to see what's routed where.
const SECTION_CLASSES = [
  ['Direct', 'in-direct'],
  ['Proxy', 'in-proxy'],
  ['Block', 'in-block']
];
function applySectionTint(elm, type, value, addBtn) {
  const key = ruleKey(type, value);
  elm.classList.remove('in-direct', 'in-proxy', 'in-block');
  let any = false;
  for (const [sec, cls] of SECTION_CLASSES) {
    if (state.rules.some((r) => r.section === sec && ruleKey(r.type, r.value) === key)) {
      elm.classList.add(cls);
      any = true;
    }
  }
  if (addBtn) {
    addBtn.textContent = any ? '✓ geosite' : '+ geosite';
  }
  return any;
}

function createCatEl(cat, search) {
  const wrap = el('div', 'cat');
  wrap.dataset.code = cat.code;
  const catKey = ruleKey('geosite', cat.code);
  wrap.dataset.geokey = catKey;

  const head = el('div', 'cat-head');
  const chev = el('span', 'cat-chevron', '▶');
  const name = el('span', 'cat-name', cat.code);
  const count = el('span', 'cat-count',
    search ? '(' + search.matches.length + '/' + cat.count + ')' : '(' + cat.count + ')');
  if (search) count.title = 'совпадений / всего доменов';
  const addBtn = el('button', 'cat-add', '+ geosite');
  addBtn.title = 'Добавить geosite:' + cat.code + ' в правила';
  // Which section(s) already hold geosite:<CODE> — visible from any tab.
  // Green Direct / blue Proxy / red Block; the row text and the ✓ button
  // take the color of the section, mixed when present in several.
  applySectionTint(wrap, 'geosite', cat.code, addBtn);
  if (wrap.dataset.sectint) { addBtn.textContent = '✓ geosite'; }

  head.append(chev, name, count, addBtn);
  const body = el('div', 'cat-body');
  wrap.append(head, body);

  // In content-search mode: open immediately and show only matched domains.
  if (search) {
    wrap.classList.add('open');
    chev.textContent = '▼';
    body._loaded = true;
    fillCatBodyMatches(cat.code, body, search.matches, search.query);
  }

  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (state.addedKeys.has(catKey)) {
      // toggle off — scoped to the section on screen, so this can't reach into
      // another section's identically-named rule
      const r = state.rules.find(
        (x) => x.section === state.currentSection && ruleKey(x.type, x.value) === catKey
      );
      if (r) { removeRule(r.id); toast('Удалено geosite:' + cat.code); }
    } else if (addRule('geosite', cat.code, { flash: true })) {
      syncMarks();
      toast('Добавлено geosite:' + cat.code, 'ok');
    }
  });

  head.addEventListener('click', async () => {
    const opening = !wrap.classList.contains('open');
    wrap.classList.toggle('open', opening);
    chev.textContent = opening ? '▼' : '▶';
    if (opening && !body._loaded) {
      await fillCatBody(cat.code, body, count);
      body._loaded = true;
    }
  });

  return wrap;
}

async function fillCatBody(code, body, countEl) {
  let domains = state.geositeCache[code];
  if (!domains) {
    domains = await window.api.geositeDomains(code);
    state.geositeCache[code] = domains;
  }
  body.innerHTML = '';
  const inner = el('div', 'cat-inner');

  // add-domain row
  const addRow = el('div', 'dom-add');
  const addInput = el('input');
  addInput.type = 'text';
  addInput.placeholder = 'добавить домен…';
  const addBtn = el('button', null, '＋');
  addRow.append(addInput, addBtn);
  const doAdd = async () => {
    const v = addInput.value.trim();
    if (!v) return;
    await window.api.geositeAddDomain({ code, type: 'domain', value: v });
    if (!state.geositeCache[code]) {
      state.geositeCache[code] = await window.api.geositeDomains(code);
    }
    state.geositeCache[code].push({ type: 'domain', value: v });
    addInput.value = '';
    refreshCatBody(code, body, countEl);
  };
  addBtn.addEventListener('click', doAdd);
  addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doAdd(); });
  inner.appendChild(addRow);

  domains.forEach((d, i) => inner.appendChild(createDomEl(code, d, i, body, countEl)));
  body.appendChild(inner);
  if (countEl) countEl.textContent = '(' + domains.length + ')';
}

function refreshCatBody(code, body, countEl) {
  body._loaded = true;
  fillCatBody(code, body, countEl);
}

// Render only the domains that matched the content-search, highlighted.
function fillCatBodyMatches(code, body, matches, query) {
  // cache full list too, so toggling later works without refetch surprises
  body.innerHTML = '';
  const inner = el('div', 'cat-inner');

  const hint = el('div', 'match-hint', 'совпадения по «' + query + '»:');
  inner.appendChild(hint);

  matches.forEach((d, i) => {
    const row = createDomEl(code, d, i, body, null);
    highlightVal(row, query);
    inner.appendChild(row);
  });

  const allBtn = el('button', 'show-all-btn', 'показать все домены категории');
  allBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    refreshCatBody(code, body, null);
  });
  inner.appendChild(allBtn);

  body.appendChild(inner);
}

function highlightVal(row, query) {
  const val = row.querySelector('.val');
  if (!val) return;
  const text = val.textContent;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return;
  val.textContent = '';
  val.append(
    document.createTextNode(text.slice(0, idx)),
    el('mark', null, text.slice(idx, idx + query.length)),
    document.createTextNode(text.slice(idx + query.length))
  );
}

function domTypeToRule(dt) {
  return dt === 'regex' ? 'regexp' : 'domain';
}

function createDomEl(code, d, index, body, countEl) {
  const row = el('div', 'dom');
  const ruleType = domTypeToRule(d.type);
  const key = ruleKey(ruleType, d.value);
  row.dataset.key = key;
  row.draggable = true;

  // Same section tint as categories: the domain's text turns green/blue/red
  // if it's in Direct/Proxy/Block rules — visible from any tab.
  applySectionTint(row, ruleType, d.value, null);

  const dtype = el('span', 'dtype', d.type);
  const val = el('span', 'val', d.value);
  val.title = d.value;
  const del = el('button', 'ddel', '🗑');
  del.title = 'Удалить домен из категории';

  row.append(dtype, val, del);

  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    // hydrate cache if the row came from content-search or the .dat was reloaded
    if (!state.geositeCache[code]) {
      state.geositeCache[code] = await window.api.geositeDomains(code);
    }
    const realIndex = state.geositeCache[code].findIndex((x) => x.value === d.value && x.type === d.type);
    await window.api.geositeRemoveDomain({ code, index: realIndex });
    if (realIndex >= 0) state.geositeCache[code].splice(realIndex, 1);
    row.style.transition = 'opacity .2s, transform .2s';
    row.style.opacity = '0';
    row.style.transform = 'translateX(20px)';
    setTimeout(() => {
      refreshCatBody(code, body, countEl);
    }, 200);
  });

  row.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-rule', JSON.stringify([{ type: ruleType, value: d.value }]));
  });

  return row;
}

/* ============================ GeoIP column ============================ */
const geoipTiles = $('#geoip-tiles');

$('#geoip-load').addEventListener('click', loadGeoip);
$('#geoip-file').addEventListener('click', async () => {
  try {
    const f = await window.api.openFile({ filters: [{ name: 'GeoIP dat', extensions: ['dat'] }] });
    if (!f) return;
    const res = await window.api.geoipLoad({ fileData: f.data });
    state.geoipMeta = res.countries;
    state.geoipSource = f.path.split('\\').pop();
    renderGeoipTiles();
    const status = $('#geoip-status');
    status.className = 'status ok';
    status.textContent = `Загружен файл: ${f.path.split('\\').pop()} — стран: ${res.countries.length}`;
  } catch (err) {
    const status = $('#geoip-status');
    status.className = 'status error';
    status.textContent = 'Ошибка чтения .dat: ' + err.message;
  }
});
$('#geoip-filter').addEventListener('input', renderGeoipTiles);

async function loadGeoip() {
  const url = $('#geoip-url').value.trim();
  const status = $('#geoip-status');
  status.className = 'status';
  status.innerHTML = 'Загрузка <span class="spin">⟳</span>';
  try {
    let payload;
    let f = null;
    if (/^https?:\/\//i.test(url)) payload = { url };
    else {
      f = await window.api.openFile({ filters: [{ name: 'dat', extensions: ['dat'] }] });
      if (!f) { status.textContent = ''; return; }
      payload = { fileData: f.data };
    }
    const res = await window.api.geoipLoad(payload);
    state.geoipMeta = res.countries;
    state.geoipSource = /^https?:\/\//i.test(url) ? url : (f ? f.path.split('\\').pop() : url);
    renderGeoipTiles();
    status.className = 'status ok';
    status.textContent = `Загружено стран: ${res.countries.length}`;
  } catch (err) {
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
  }
}

function renderGeoipTiles() {
  const filter = $('#geoip-filter').value.trim().toUpperCase();
  geoipTiles.innerHTML = '';
  const list = filter
    ? state.geoipMeta.filter((c) => c.code.includes(filter))
    : state.geoipMeta;
  for (const c of list) geoipTiles.appendChild(createTileEl(c));
}

function createTileEl(c) {
  const key = ruleKey('geoip', c.code);
  const tile = el('div', 'tile');
  tile.dataset.key = key;
  tile.draggable = true;
  if (state.addedKeys.has(key)) tile.classList.add('added');
  tile.append(el('div', 'tile-code', c.code), el('div', 'tile-count', c.count + ' cidr'));

  tile.addEventListener('click', () => {
    if (addRule('geoip', c.code, { flash: true })) {
      syncMarks();
      toast('Добавлено geoip:' + c.code, 'ok');
    } else {
      // toggle off if already present — scoped to the displayed section
      const r = state.rules.find(
        (x) => x.section === state.currentSection && ruleKey(x.type, x.value) === key
      );
      if (r) { removeRule(r.id); toast('Удалено geoip:' + c.code); }
    }
  });

  tile.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/x-rule', JSON.stringify([{ type: 'geoip', value: c.code }]));
  });

  return tile;
}

/* ============================ Section tabs ============================ */
/* Editor-only: the converter's .conv-section-tabs have their own handlers
   (see convSrcTabs above) — a global selector here would fight them for the
   .active class and overwrite state.currentSection from converter clicks. */
document.querySelectorAll('#view-editor .section-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#view-editor .section-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentSection = tab.dataset.section;
    refreshAddedKeys();   // marks track the section now on screen
    renderRulesList();
    updateRulesCount();
    syncMarks();
  });
});

/* ============================ Init ============================ */
// The previous session is NOT restored automatically: it's held in
// pendingSession and offered via a banner (no timer). «Восстановить» applies
// it; the little × declines and wipes the stored snapshot — a fresh start,
// matching the old behavior.
loadSavedRules();
refreshAddedKeys();
renderRulesList();
updateRulesCount();
syncMarks();

// Debounced saves can still be pending when the window goes away. Pass a
// marker so beforeunload can flush honestly without arming saveDirty: closing
// an untouched app is NOT a mutation and must not tombstone the stored session.
window.addEventListener('beforeunload', (e) => { if (saveDirty) saveRulesNow(); });

// ---- "Восстановить сессию?" offer ----
// Stays up until answered: «Восстановить» applies the snapshot, the little ×
// in the corner declines and wipes the stored data. No timer.
function showSessionOffer() {
  if (!pendingSession) return;
  const n = pendingSession.rules.length;
  const gfCats = pendingSession.gf
    ? pendingSession.gf.geosite.length + pendingSession.gf.geoip.length : 0;
  const parts = [];
  if (n) parts.push(n + ' ' + pluralRu(n, 'правило', 'правила', 'правил'));
  if (gfCats) parts.push(gfCats + ' ' + pluralRu(gfCats, 'категория', 'категории', 'категорий'));
  if (!parts.length) return;

  const bar = el('div', 'session-offer');
  const msg = el('span', 'so-msg', 'Восстановить сессию? (' + parts.join(', ') + ')');
  const btn = el('button', 'btn primary', 'Восстановить');
  const closeBtn = el('button', 'so-close', '×');
  closeBtn.title = 'Не восстанавливать и очистить';
  closeBtn.setAttribute('aria-label', 'Закрыть');
  bar.append(msg, btn, closeBtn);
  document.body.appendChild(bar);

  const close = () => {
    bar.classList.add('leaving');
    setTimeout(() => bar.remove(), 250);
  };
  btn.addEventListener('click', () => {
    applyPendingSession();
    toast('Сессия восстановлена', 'ok');
    close();
  });
  // ×: declined — stored data goes away for a clean start next launch.
  closeBtn.addEventListener('click', () => {
    discardPendingSession();
    close();
  });
}

// Russian plural: 1 правило / 2 правила / 5 правил.
function pluralRu(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
showSessionOffer();

/* ============================ Geofiles ============================ */
// Fully standalone tab — its own state, not shared with Editor/Converter.
const gfState = {
  mode: 'geosite',      // 'geosite' | 'geoip'
  srcMeta: [],          // [{ code, count }] loaded source categories
  srcCache: {},         // code -> items (domains [{type,value}] or cidr [string])
  cats: { geosite: [], geoip: [] }, // [{ code, items }] — items: domains or cidrs
  selected: null        // code of selected "my category"
};
let gfContentOpen = false;

$('#gf-src-load').addEventListener('click', gfLoadSource);
$('#gf-src-file').addEventListener('click', async () => {
  const isGeo = gfState.mode === 'geosite';
  try {
    const f = await window.api.openFile({ filters: [{ name: (isGeo ? 'Geosite' : 'GeoIP') + ' dat', extensions: ['dat'] }] });
    if (!f) return;
    await gfApplySource({ fileData: f.data });
  } catch (err) {
    const status = $('#gf-src-status');
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
  }
});
$('#gf-src-filter').addEventListener('input', gfRenderTree);

let gfSearchTimer = null;
$('#gf-src-search').addEventListener('input', () => {
  clearTimeout(gfSearchTimer);
  gfSearchTimer = setTimeout(gfRunSearch, 220);
});

// My-categories search: filter categories by name, filter items by domain.
$('#gf-cat-filter').addEventListener('input', gfRenderCatList);
$('#gf-cat-search').addEventListener('input', gfRenderCatContent);

document.querySelectorAll('.gf-subtab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.gf-subtab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    gfState.mode = tab.dataset.gf;
    gfState.selected = null; // categories are per-mode — drop selection from the other mode
    const def = gfState.mode === 'geosite'
      ? 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geosite.dat'
      : 'https://github.com/Loyalsoldier/v2ray-rules-dat/releases/latest/download/geoip.dat';
    if (!$('#gf-src-url').value.trim() || gfState.srcMeta.length === 0) $('#gf-src-url').value = def;
    gfState.srcMeta = [];
    gfState.srcCache = {};
    $('#gf-src-status').textContent = '';
    $('#gf-src-search').value = '';
    gfRenderTree();
    gfRenderCatList();
    gfRenderCatContent();
  });
});

async function gfLoadSource() {
  const url = $('#gf-src-url').value.trim();
  const status = $('#gf-src-status');
  status.className = 'status';
  status.innerHTML = 'Загрузка <span class="spin">⟳</span>';
  try {
    let payload;
    if (/^https?:\/\//i.test(url)) payload = { url };
    else {
      const f = await window.api.openFile({ filters: [{ name: (gfState.mode === 'geosite' ? 'Geosite' : 'GeoIP') + ' dat', extensions: ['dat'] }] });
      if (!f) { status.textContent = ''; return; }
      payload = { fileData: f.data };
    }
    await gfApplySource(payload);
  } catch (err) {
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
  }
}

async function gfApplySource(payload) {
  const status = $('#gf-src-status');
  const res = gfState.mode === 'geosite' ? await window.api.geositeLoad(payload) : await window.api.geoipLoad(payload);
  gfState.srcMeta = gfState.mode === 'geosite' ? res.categories : res.countries;
  gfState.srcCache = {};
  status.className = 'status ok';
  status.textContent = `Загружено: ${gfState.srcMeta.length} категорий`;
  gfRenderTree();
}

async function gfLoadItems(code) {
  if (gfState.srcCache[code]) return gfState.srcCache[code];
  const isGeo = gfState.mode === 'geosite';
  let items;
  if (isGeo) items = await window.api.geositeDomains(code);
  else items = await window.api.geoipCidrs(code);
  if (!items) items = [];
  gfState.srcCache[code] = items;
  return items;
}

async function gfRenderTree() {
  // Content-search takes over the tree when active.
  if ($('#gf-src-search').value.trim()) { await gfRunSearch(); return; }
  const tree = $('#gf-src-tree');
  const filter = $('#gf-src-filter').value.trim().toUpperCase();
  tree.innerHTML = '';
  const list = filter ? gfState.srcMeta.filter((c) => c.code.includes(filter)) : gfState.srcMeta;
  if (!list.length) {
    tree.innerHTML = '<div class="empty-hint">Загрузите источник, чтобы увидеть список.</div>';
    return;
  }
  // GeoIP: render country tiles like the editor (click = add all its CIDRs to a category).
  if (gfState.mode === 'geoip') {
    const grid = el('div', 'tiles gf-geoip-tiles');
    for (const c of list) grid.appendChild(gfSrcTileEl(c));
    tree.appendChild(grid);
    return;
  }
  for (const cat of list) tree.appendChild(gfSrcCatEl(cat));
  // Refresh +/✓ circles and "＋ все" done-marks after any re-render.
  await gfSyncSrcMarks();
}

// GeoIP country tile — click adds the whole country's CIDRs to the selected category.
function gfSrcTileEl(c) {
  const tile = el('div', 'tile');
  tile.append(el('div', 'tile-code', c.code), el('div', 'tile-count', c.count + ' cidr'));
  tile.addEventListener('click', async () => {
    const items = await gfLoadItems(c.code);
    if (!items.length) return;
    const cats = gfState.cats[gfState.mode];
    let target = cats.find((x) => x.code === c.code);
    if (!target) {
      target = { code: c.code, items: [] };
      cats.push(target);
    }
    gfState.selected = target.code;
    const seen = new Set(target.items.map((it) => String(it).toLowerCase()));
    let n = 0;
    for (const cidr of items) {
      const key = String(cidr).toLowerCase();
      if (!seen.has(key)) { target.items.push(cidr); seen.add(key); n++; }
    }
    gfContentOpen = true;
    gfRenderCatList();
    gfRenderCatContent();
    scheduleSave();
    toast('geoip:' + c.code + ': добавлено ' + n, 'ok');
  });
  return tile;
}

async function gfRunSearch() {
  const q = $('#gf-src-search').value.trim();
  const status = $('#gf-src-status');
  const tree = $('#gf-src-tree');
  if (!q) { gfRenderTree(); return; }
  if (gfState.mode === 'geoip') {
    // GeoIP has no domain content search — fall back to country-code filter.
    const filter = q.toUpperCase();
    tree.innerHTML = '';
    const list = gfState.srcMeta.filter((c) => c.code.includes(filter));
    if (!list.length) {
      status.className = 'status';
      status.textContent = `По «${q}» ничего не найдено`;
      return;
    }
    for (const cat of list) tree.appendChild(gfSrcCatEl(cat));
    status.className = 'status';
    status.textContent = `Найдено стран: ${list.length}`;
    return;
  }
  if (!gfState.srcMeta.length) {
    status.className = 'status error';
    status.textContent = 'Сначала загрузите geosite.dat';
    return;
  }
  status.className = 'status';
  status.innerHTML = 'Поиск <span class="spin">⟳</span>';
  const results = await window.api.geositeSearch(q);
  tree.innerHTML = '';
  if (!results.length) {
    status.className = 'status';
    status.textContent = `По «${q}» ничего не найдено`;
    return;
  }
  let totalHits = 0;
  for (const r of results) {
    totalHits += r.matches.length;
    tree.appendChild(gfSearchCatEl(r));
  }
  status.className = 'status ok';
  status.textContent = `Найдено: ${totalHits} доменов в ${results.length} категориях`;
  gfSyncSrcMarks();
}

// Category rendered from content-search results, with matches and a "+" per domain.
function gfSearchCatEl(r) {
  const wrap = el('div', 'gf-src-cat open');
  const head = el('div', 'gf-src-cat-head');
  const name = el('span', 'gf-src-cat-name', r.code);
  const cnt = el('span', 'cat-count', '(' + r.matches.length + '/' + r.total + ')');
  const addAll = gfAddAllBtn(r.code);
  head.append(name, cnt, addAll);
  const body = el('div', 'gf-src-cat-body');
  wrap.append(head, body);
  // Reuse the standard source body renderer (matches are already domain objects).
  gfFillSrcBody(body, r.matches);
  return wrap;
}

// "＋ все" button: adds the whole source category into "My categories".
function gfAddAllBtn(code) {
  const addAll = el('button', 'gf-src-add-all', '＋ все');
  addAll.title = 'Перенести всю категорию в «Мои категории»';
  addAll.addEventListener('click', async (e) => {
    e.stopPropagation();
    const items = await gfLoadItems(code);
    if (!items.length) return;
    const cats = gfState.cats[gfState.mode];
    let target = cats.find((c) => c.code === code);
    if (!target) {
      target = { code, items: [] };
      cats.push(target);
    }
    gfState.selected = target.code;
    const seen = new Set(target.items.map((it) => String(it.value != null ? it.value : it).toLowerCase()));
    let n = 0;
    for (const it of items) {
      const key = String(it.value != null ? it.value : it).toLowerCase();
      if (!seen.has(key)) { target.items.push(it); seen.add(key); n++; }
    }
    gfContentOpen = true;
    // Clear filters so the newly added category and its items are always visible.
    $('#gf-cat-filter').value = '';
    $('#gf-cat-search').value = '';
    scheduleSave();
    gfRenderCatList();
    gfRenderCatContent();
    gfSyncSrcMarks();
    toast('Категория ' + code + ': перенесено ' + n, 'ok');
  });
  return addAll;
}

function gfSrcCatEl(cat) {
  const wrap = el('div', 'gf-src-cat');
  const head = el('div', 'gf-src-cat-head');
  const name = el('span', 'gf-src-cat-name', cat.code);
  const cnt = el('span', 'cat-count', '(' + cat.count + ')');
  const addAll = gfAddAllBtn(cat.code);
  head.append(name, cnt, addAll);
  const body = el('div', 'gf-src-cat-body');
  wrap.append(head, body);

  let open = false;
  head.addEventListener('click', async (e) => {
    if (e.target.closest('button')) return;
    open = !open;
    wrap.classList.toggle('open', open);
    if (open && !body._loaded) {
      const items = await gfLoadItems(cat.code);
      body._loaded = true;
      gfFillSrcBody(body, items);
    }
  });

  return wrap;
}

// Sync the +/✓ circles in the source tree to reflect what's already in the selected category.
async function gfSyncSrcMarks() {
  if (!gfState.selected) return;
  const cat = gfState.cats[gfState.mode].find((c) => c.code === gfState.selected);
  if (!cat) return;
  const isGeo = gfState.mode === 'geosite';
  const added = new Set(cat.items.map((it) => String(isGeo ? it.value : it).toLowerCase()));
  document.querySelectorAll('#gf-src-tree .gf-src-item').forEach((row) => {
    const lbl = row.querySelector('.gf-src-item-label');
    if (!lbl) return;
    const key = String(lbl.textContent).trim().toLowerCase();
    const isAdded = added.has(key);
    row.classList.toggle('added', isAdded);
    const circle = row.querySelector('.circle');
    if (circle) {
      circle.classList.toggle('on', isAdded);
      circle.textContent = isAdded ? '✓' : '+';
    }
  });
  await gfSyncSrcAll();
}

// Mark "＋ все" buttons as done when a matching category in "My categories" already contains every domain/IP.
async function gfSyncSrcAll() {
  const isGeo = gfState.mode === 'geosite';
  const cats = gfState.cats[gfState.mode];
  const srcCats = document.querySelectorAll('#gf-src-tree .gf-src-cat');
  if (!srcCats.length) return;

  // Collect the visible codes first, then ask main once. The old loop awaited
  // one IPC round-trip per category and pulled every domain list across the
  // bridge just to compare them — re-running on every item added.
  const wraps = [];
  for (const wrap of srcCats) {
    const nameEl = wrap.querySelector('.gf-src-cat-name');
    const addAll = wrap.querySelector('.gf-src-add-all');
    if (!nameEl || !addAll) continue;
    wraps.push({ wrap, addAll, code: nameEl.textContent.trim() });
  }
  if (!wraps.length) return;

  // Same target as before: the same-named "my category", else the selected one.
  const codes = wraps.map((w) => w.code);
  const named = new Map(cats.map((c) => [c.code, c]));
  const selected = cats.find((c) => c.code === gfState.selected);
  // Group codes by the category they're compared against, so each distinct
  // "have" set costs one call rather than one call per code.
  const groups = new Map();
  for (const code of codes) {
    const match = named.get(code) || selected || null;
    const items = match ? match.items : [];
    if (!groups.has(match)) groups.set(match, { items, codes: [] });
    groups.get(match).codes.push(code);
  }

  const covered = {};
  for (const [, g] of groups) {
    const have = g.items.map((it) => String(isGeo ? it.value : it));
    try {
      Object.assign(covered, await window.api.geoCoveredBy({
        kind: gfState.mode, codes: g.codes, have
      }));
    } catch (_) { /* leave those codes unmarked */ }
  }

  for (const { wrap, addAll, code } of wraps) {
    const all = covered[code] === true;
    wrap.classList.toggle('cat-done', all);
    addAll.textContent = all ? '✓ все' : '＋ все';
    addAll.title = all ? 'Вся категория уже в «Моих категориях»' : 'Перенести всю категорию в «Мои категории»';
  }
}

// Map a domain/rule type to the editor's colored tag class.
function gfTagType(type, isGeo) {
  if (!isGeo) return 'geoip';
  const t = String(type || 'domain').toLowerCase();
  if (t === 'regex' || t === 'regexp') return 'regexp';
  if (t === 'keyword') return 'keyword';
  if (t === 'plain') return 'plain';
  if (t === 'full') return 'full';
  return 'domain';
}

// Editor-style colored tag span.
function gfTagSpan(type, isGeo) {
  const cls = gfTagType(type, isGeo);
  return el('span', 'tag ' + cls, cls === 'regexp' ? 'regexp' : cls);
}

function gfFillSrcBody(body, items) {
  body.innerHTML = '';
  const inner = el('div', 'gf-src-inner');
  const isGeo = gfState.mode === 'geosite';
  // A domain is "already mine" when it exists in ANY of my categories, not
  // just the selected one — during a content search the user usually has no
  // category selected and would otherwise see everything as un-added.
  const addedKeys = new Set();
  for (const cat of gfState.cats[gfState.mode]) {
    for (const it of cat.items) {
      addedKeys.add(String(isGeo ? it.value : it).toLowerCase());
    }
  }
  for (const item of items) {
    const row = el('div', 'gf-src-item');
    const label = isGeo ? item.value : item;
    const key = String(isGeo ? it_value(item, isGeo) : item).toLowerCase();
    const isAdded = addedKeys.has(key);
    if (isAdded) row.classList.add('added');
    // Editor-style circle with +/✓
    const circle = el('div', 'circle' + (isAdded ? ' on' : ''));
    circle.textContent = isAdded ? '✓' : '+';
    circle.title = isAdded ? 'Уже добавлено' : 'Добавить в категорию';
    circle.addEventListener('click', (e) => {
      e.stopPropagation();
      gfAddItem(isGeo ? { type: item.type, value: item.value } : item);
    });
    row.append(circle, gfTagSpan(item.type, isGeo), el('span', 'gf-src-item-label', label));
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'copy';
      const data = JSON.stringify(isGeo ? { type: item.type, value: item.value } : { cidr: item });
      e.dataTransfer.setData('application/x-gf-item', data);
    });
    inner.appendChild(row);
  }
  body.appendChild(inner);
}

// geosite items are objects ({type,value}), geoip ones are plain CIDR strings.
function it_value(item, isGeo) { return isGeo ? item.value : item; }

// ---- Bulk list import into the selected "my category" ----
// Adding domains one at a time is painful for a ready-made list, so accept the
// same `type:value` syntax the .dat files use, pasted or read from a .txt.

// Types the encoder understands (see gfTagType / datparser).
const GF_TYPES = new Set(['domain', 'full', 'keyword', 'regexp', 'regex', 'plain']);

// Returns { items, skipped } — items shaped for gfState (geosite: {type,value}, geoip: string).
function gfParseList(text, isGeo) {
  const items = [];
  let skipped = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    if (!isGeo) {
      // geoip categories hold CIDRs / bare IPs.
      const v = line.replace(/^(?:ip|ip-cidr|cidr)\s*[:,]\s*/i, '').trim();
      if (/^[0-9a-f:.]+(?:\/\d{1,3})?$/i.test(v)) items.push(v);
      else skipped++;
      continue;
    }
    const m = /^([a-z-]+)\s*:\s*(.+)$/i.exec(line);
    if (m && GF_TYPES.has(m[1].toLowerCase())) {
      let type = m[1].toLowerCase();
      if (type === 'regexp') type = 'regex';   // internal name, cf. gf-qa-add
      items.push({ type, value: m[2].trim() });
    } else if (m && /^(geosite|geoip|ext)$/i.test(m[1])) {
      skipped++;   // references to other lists can't be inlined here
    } else {
      // No recognized prefix: treat as a plain domain, like the editor does.
      items.push({ type: 'domain', value: line });
    }
  }
  return { items, skipped };
}

const gfListModal = $('#gf-list-modal');
let gfListTargetCode = null;

function gfOpenListModal(code) {
  gfListTargetCode = code;
  $('#gf-list-target').textContent = code;
  $('#gf-list-textarea').value = '';
  $('#gf-list-replace').checked = false;
  const st = $('#gf-list-status');
  st.className = 'status';
  st.textContent = '';
  gfListModal.hidden = false;
  $('#gf-list-textarea').focus();
}

function gfCloseListModal() {
  gfListModal.hidden = true;
  gfListTargetCode = null;
}

// Applies parsed items to the target category in one pass: dedupe against what
// is already there, then a single re-render and a single toast — gfAddItem would
// fire a toast, a re-render and a mark-sync per entry.
function gfApplyList(text) {
  const isGeo = gfState.mode === 'geosite';
  const cat = gfState.cats[gfState.mode].find((c) => c.code === gfListTargetCode);
  if (!cat) { toast('Категория не найдена', 'err'); return; }

  const { items, skipped } = gfParseList(text, isGeo);
  if (!items.length) {
    const st = $('#gf-list-status');
    st.className = 'status error';
    st.textContent = skipped
      ? `Не распознано ни одной записи (пропущено ${skipped}) — ничего не изменено`
      : 'Не распознано ни одной записи — ничего не изменено';
    return;
  }

  const replace = $('#gf-list-replace').checked;
  if (replace) cat.items = [];
  // Key on type+value: `domain:pubg.com` and `full:pubg.com` are different
  // rules (subdomains vs exact match), so value alone would silently drop one.
  const keyOf = (it) => (isGeo
    ? gfTagType(it.type, true) + '\u0000' + String(it.value).toLowerCase()
    : String(it).toLowerCase());
  const seen = new Set(cat.items.map(keyOf));
  let added = 0;
  let dupes = 0;
  for (const it of items) {
    const k = keyOf(it);
    if (seen.has(k)) { dupes++; continue; }
    seen.add(k);
    cat.items.push(it);
    added++;
  }

  gfContentOpen = true;
  $('#gf-cat-search').value = '';
  scheduleSave();
  gfRenderCatContent();
  gfRenderCatList();
  gfSyncSrcMarks();
  gfCloseListModal();

  const parts = [`Добавлено: ${added}`];
  if (dupes) parts.push(`дубликатов: ${dupes}`);
  if (skipped) parts.push(`пропущено: ${skipped}`);
  toast(parts.join(', '), added ? 'ok' : 'err', 4500);
}

$('#gf-list-apply').addEventListener('click', () => {
  gfApplyList($('#gf-list-textarea').value);
});
$('#gf-list-cancel').addEventListener('click', gfCloseListModal);
gfListModal.addEventListener('click', (e) => { if (e.target === gfListModal) gfCloseListModal(); });

$('#gf-list-file').addEventListener('click', async () => {
  try {
    const text = await window.api.openText();   // main-side dialog, txt/json/conf/list
    if (text == null) return;
    // Show what was read so the user can eyeball it before applying.
    $('#gf-list-textarea').value = text;
    const st = $('#gf-list-status');
    st.className = 'status ok';
    st.textContent = 'Файл загружен — проверьте и нажмите «Добавить»';
  } catch (err) {
    const st = $('#gf-list-status');
    st.className = 'status error';
    st.textContent = 'Ошибка чтения файла: ' + err.message;
  }
});

function gfAddItem(itemOrCidr) {
  // Auto-select the first category if none is chosen yet.
  if (!gfState.selected) {
    const cats = gfState.cats[gfState.mode];
    if (cats.length) gfState.selected = cats[0].code;
  }
  if (!gfState.selected) return toast('Сначала создайте категорию справа (＋ Категория)', 'err');
  const cat = gfState.cats[gfState.mode].find((c) => c.code === gfState.selected);
  if (!cat) return toast('Категория не найдена', 'err');
  const isGeo = gfState.mode === 'geosite';
  const key = isGeo ? String(itemOrCidr.value).toLowerCase() : String(itemOrCidr).toLowerCase();
  const exists = cat.items.some((it) => (isGeo ? String(it.value) : String(it)).toLowerCase() === key);
  if (exists) return toast('Уже есть', 'err');
  cat.items.push(itemOrCidr);
  scheduleSave();
  gfContentOpen = true; // show the result right away
  // Clear the item search so the added item is visible.
  $('#gf-cat-search').value = '';
  gfRenderCatContent();
  gfRenderCatList();
  gfSyncSrcMarks();
  // Flash the matching source row green, editor-style.
  const rows = document.querySelectorAll('#gf-src-tree .gf-src-item');
  rows.forEach((row) => {
    const lbl = row.querySelector('.gf-src-item-label');
    if (lbl && lbl.textContent.trim().toLowerCase() === key) {
      row.classList.remove('flash');
      void row.offsetWidth;
      row.classList.add('flash');
    }
  });
  toast('Перенесено', 'ok');
}

// ---- My categories list (right column) ----
function gfRenderCatList() {
  const list = $('#gf-cat-list');
  list.innerHTML = '';
  const filter = $('#gf-cat-filter').value.trim().toUpperCase();
  const cats = filter
    ? gfState.cats[gfState.mode].filter((c) => c.code.includes(filter))
    : gfState.cats[gfState.mode];
  for (const c of cats) {
    const row = el('div', 'gf-cat-row');
    if (c.code === gfState.selected) row.classList.add('active');
    const name = el('span', 'gf-cat-row-name', c.code);
    const cnt = el('span', 'cat-count', c.items.length + '');
    const delBtn = el('button', 'gf-cat-del', '✕');
    delBtn.title = 'Удалить категорию';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const all = gfState.cats[gfState.mode];
      const idx = all.findIndex((x) => x.code === c.code);
      if (idx >= 0) all.splice(idx, 1);
      if (gfState.selected === c.code) { gfState.selected = null; gfRenderCatContent(); }
      scheduleSave();
      gfRenderCatList();
      gfUpdateCount();
    });
    row.append(name, cnt, delBtn);
    row.addEventListener('click', () => {
      // Clicking the already-active category deselects it.
      if (gfState.selected === c.code) {
        gfState.selected = null;
        gfRenderCatContent();
        gfRenderCatList();
        return;
      }
      gfState.selected = c.code;
      gfContentOpen = false;
      document.querySelectorAll('.gf-cat-row').forEach((r) => r.classList.remove('active'));
      row.classList.add('active');
      gfRenderCatContent();
    });
    list.appendChild(row);
  }
  gfUpdateCount();
}

function gfUpdateCount() {
  $('#gf-mine-count').textContent = gfState.cats[gfState.mode].length;
}

// ---- My category content (right bottom) ----
function gfRenderCatContent() {
  const container = $('#gf-cat-content');
  container.innerHTML = '';
  if (!gfState.selected) {
    container.innerHTML = '<div class="empty-hint">Выберите категорию слева.</div>';
    return;
  }
  const cat = gfState.cats[gfState.mode].find((c) => c.code === gfState.selected);
  if (!cat) { container.innerHTML = '<div class="empty-hint">Категория не найдена.</div>'; return; }

  // Filter items by the search field.
  const searchQ = $('#gf-cat-search').value.trim().toLowerCase();
  const items = searchQ
    ? cat.items.filter((it) => String(it.value != null ? it.value : it).toLowerCase().includes(searchQ))
    : cat.items;
  const itemCount = items.length;
  const totalCount = cat.items.length;
  const head = el('div', 'gf-cat-head gf-cat-head-toggle' + (gfContentOpen ? ' open' : ''));
  const chev = el('span', 'gf-chevron', gfContentOpen ? '▼' : '▶');
  const title = el('span', 'gf-cat-title', cat.code);
  const cnt = el('span', 'cat-count', '(' + itemCount + ')');
  const renameBtn = el('button', 'btn ghost', '✎');
  renameBtn.title = 'Переименовать';
  renameBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = el('input');
    input.type = 'text';
    input.value = cat.code;
    input.style = 'flex:1;min-width:0';
    const okBtn = el('button', 'btn primary', 'OK');
    title.replaceWith(input);
    renameBtn.replaceWith(okBtn);
    input.focus();
    input.select();
    const commit = () => {
      const nv = input.value.trim();
      if (nv && nv.toUpperCase() !== cat.code) {
        const cats = gfState.cats[gfState.mode];
        const dup = cats.some((c) => c.code === nv.toUpperCase());
        if (!dup) { cat.code = nv.toUpperCase(); gfState.selected = cat.code; scheduleSave(); }
        else toast('Такая категория уже есть', 'err');
      }
      gfRenderCatList();
      gfRenderCatContent();
    };
    okBtn.addEventListener('click', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') { gfRenderCatList(); gfRenderCatContent(); }
    });
  });
  const importBtn = el('button', 'btn ghost', '⤓');
  importBtn.title = 'Импорт списка в эту категорию (текст или .txt файл)';
  importBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    gfOpenListModal(cat.code);
  });
  head.append(chev, title, cnt, importBtn, renameBtn);
  head.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    gfContentOpen = !gfContentOpen;
    gfRenderCatContent();
  });
  container.appendChild(head);

  if (gfContentOpen) {
    const itemsContainer = el('div', 'gf-items');
    const isGeo = gfState.mode === 'geosite';
    items.forEach((item, i) => {
      const row = el('div', 'gf-item');
      const label = isGeo ? item.value : item;
      row.append(gfTagSpan(item.type, isGeo));
      row.append(el('span', 'gf-item-label', label));
      const delBtn = el('button', 'gf-item-del', '✕');
      delBtn.addEventListener('click', () => {
        cat.items.splice(cat.items.indexOf(item), 1);
        scheduleSave();
        gfRenderCatContent();
        gfRenderCatList();
      });
      row.appendChild(delBtn);
      itemsContainer.appendChild(row);
    });
    container.appendChild(itemsContainer);
  } else if (itemCount > 0) {
    const hint = el('div', 'gf-collapsed-hint',
      itemCount + ' ' + (gfState.mode === 'geosite' ? 'доменов' : 'CIDR') + ' — нажмите на заголовок, чтобы показать');
    container.appendChild(hint);
  } else if (searchQ) {
    const hint = el('div', 'gf-collapsed-hint', 'По «' + searchQ + '» ничего не найдено');
    container.appendChild(hint);
  }
}

// ---- Drop target on my-categories column ----
$('#gf-cat-list').addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('application/x-gf-item')) e.preventDefault();
});
$('#gf-cat-list').addEventListener('drop', (e) => {
  if (!gfState.selected) return;
  const raw = e.dataTransfer.getData('application/x-gf-item');
  if (!raw) return;
  e.preventDefault();
  try {
    const data = JSON.parse(raw);
    if (gfState.mode === 'geosite' && data.type != null) gfAddItem(data);
    else if (data.cidr) gfAddItem(data.cidr);
  } catch (_) {}
});

// ---- Quick add (domain/regexp/keyword/plain) into selected category ----
$('#gf-qa-add').addEventListener('click', gfQuickAdd);
$('#gf-qa-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') gfQuickAdd(); });
function gfQuickAdd() {
  const type = $('#gf-qa-type').value;
  const v = $('#gf-qa-input').value;
  if (!v.trim()) return;
  if (type === 'regexp') {
    gfAddItem({ type: 'regex', value: v.trim() });
  } else {
    gfAddItem({ type, value: v.trim() });
  }
  $('#gf-qa-input').value = '';
  $('#gf-qa-input').focus();
}

// ---- New category (inline input) ----
$('#gf-new-cat').addEventListener('click', () => {
  const listWrap = $('#gf-cat-list');
  const row = el('div', 'gf-cat-create');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'имя категории (напр. MY-SITES)…';
  input.style = 'flex:1;min-width:0';
  const okBtn = el('button', 'btn primary', 'OK');
  row.append(input, okBtn);
  listWrap.prepend(row);
  input.focus();
  const commit = () => {
    const name = input.value.trim();
    if (name) {
      const code = name.toUpperCase();
      const cats = gfState.cats[gfState.mode];
      if (cats.some((c) => c.code === code)) toast('Такая категория уже есть', 'err');
      else {
        cats.push({ code, items: [] });
        gfState.selected = code;
        gfContentOpen = true;
        gfRenderCatList();
        gfRenderCatContent();
        scheduleSave();
      }
    }
    row.remove();
  };
  okBtn.addEventListener('click', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') row.remove();
  });
});

// ---- Export .dat ----
$('#gf-export').addEventListener('click', async () => {
  const cats = gfState.cats[gfState.mode].filter((c) => c.items.length);
  if (!cats.length) return toast('Нет непустых категорий', 'err');
  try {
    let payload;
    if (gfState.mode === 'geosite') {
      payload = { kind: 'geosite', categories: cats.map((c) => ({ code: c.code, domains: c.items })) };
    } else {
      payload = { kind: 'geoip', categories: cats.map((c) => ({ code: c.code, cidrs: c.items })) };
    }
    const buf = await window.api.encodeDat(payload);
    const defaultName = gfState.mode === 'geosite' ? 'geosite.dat' : 'geoip.dat';
    const ok = await window.api.saveDat({ defaultName, buffer: buf });
    if (ok) toast('Экспортирован ' + defaultName, 'ok');
  } catch (err) {
    toast('Ошибка: ' + err.message, 'err');
  }
});

// ---- Import .dat (Geofiles): load a geosite/geoip .dat and add its categories to "My categories"
const gfImportModal = $('#gf-import-modal');
$('#gf-import').addEventListener('click', () => { gfImportModal.hidden = false; $('#gf-import-dat-url').focus(); });
$('#gf-import-cancel').addEventListener('click', () => { gfImportModal.hidden = true; });
gfImportModal.addEventListener('click', (e) => { if (e.target === gfImportModal) gfImportModal.hidden = true; });

async function gfImportDat(payload, source) {
  const status = $('#gf-import-dat-status');
  status.className = 'status';
  status.innerHTML = 'Загрузка .dat <span class="spin">⟳</span>';
  try {
    const isGeo = gfState.mode === 'geosite';
    const res = isGeo ? await window.api.geositeLoad(payload) : await window.api.geoipLoad(payload);
    const meta = isGeo ? res.categories : res.countries;
    status.className = 'status ok';
    status.textContent = 'Категорий в .dat: ' + meta.length;
    // Import every category into "My categories" (merge into existing with same code).
    const cats = gfState.cats[gfState.mode];
    let total = 0;
    for (const m of meta) {
      let target = cats.find((c) => c.code === m.code);
      if (!target) { target = { code: m.code, items: [] }; cats.push(target); }
      const items = isGeo ? await window.api.geositeDomains(m.code) : await window.api.geoipCidrs(m.code);
      const seen = new Set(target.items.map((it) => String(it.value != null ? it.value : it).toLowerCase()));
      for (const it of items || []) {
        const key = String(it.value != null ? it.value : it).toLowerCase();
        if (!seen.has(key)) {
          if (isGeo) target.items.push({ type: it.type || 'domain', value: it.value });
          else target.items.push(it);
          seen.add(key);
          total++;
        }
      }
    }
    gfState.selected = cats.length ? cats[0].code : null;
    gfContentOpen = false;
    gfState.srcCache = {}; // the .dat store changed — invalidate cached domains
    scheduleSave();
    gfRenderCatList();
    gfRenderCatContent();
    gfSyncSrcMarks();
    toast('Импортировано .dat: ' + meta.length + ' категорий, ' + total + ' элементов', 'ok');
  } catch (err) {
    status.className = 'status error';
    status.textContent = 'Ошибка: ' + err.message;
  }
}

$('#gf-import-dat-url-fetch').addEventListener('click', () => {
  const url = $('#gf-import-dat-url').value.trim();
  if (!url) return;
  gfImportDat({ url }, url);
});

$('#gf-import-dat-file').addEventListener('click', async () => {
  const isGeo = gfState.mode === 'geosite';
  const f = await window.api.openFile({ filters: [{ name: (isGeo ? 'Geosite' : 'GeoIP') + ' dat', extensions: ['dat'] }] });
  if (!f) return;
  gfImportDat({ fileData: f.data }, f.path.split('\\').pop());
});

/* ============================ Auto-update ============================ */
const updateModal = $('#update-modal');

function updateProgressShow(label, pct) {
  const wrap = $('#update-progress');
  wrap.hidden = false;
  $('#update-progress-label').textContent = label;
  $('#update-progress-fill').style.width = Math.max(0, Math.min(100, pct)) + '%';
}

// Progress events stream from main during the main-process download.
if (window.api.onUpdateProgress) {
  window.api.onUpdateProgress((label, pct) => updateProgressShow(label, pct));
}

async function installUpdate(info) {
  const btn = $('#update-install');
  btn.disabled = true;
  updateProgressShow('Скачивание…', 3);
  try {
    // Download happens in the MAIN process: the renderer's fetch is blocked
    // by CSP (default-src 'self' on a file:// page) and by CORS on GitHub's
    // release-asset host. Progress arrives via onUpdateProgress; on success
    // main writes the exe, quits, and a swap script replaces it.
    // Only the version is sent — main resolves the asset URL from the release
    // it verified itself, so the URL never round-trips through the renderer.
    await window.api.updateInstall({ version: info.version });
  } catch (err) {
    btn.disabled = false;
    $('#update-progress').hidden = true;
    toast('Ошибка обновления: ' + err.message, 'err', 6000);
  }
}

function showUpdateModal(info) {
  $('#update-newver').textContent = 'v' + info.version;
  const curEl = $('#update-curver');
  curEl.textContent = 'v…';
  if (window.api.appVersion) {
    window.api.appVersion().then((v) => { curEl.textContent = 'v' + v; }).catch(() => {});
  }
  // Light markdown cleanup: drop duplicate version headings and emphasis
  // markers so the notes read cleanly next to the big version heading.
  const notes = String(info.notes || '')
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s*v?\d[\d.]*\s*$/gm, '')   // duplicate version title
    .replace(/^#{1,6}\s*/gm, '')                  // remaining heading hashes
    .replace(/\*\*([^*]+)\*\*/g, '$1')            // bold markers
    .replace(/^[ \t]*[-*]\s+/gm, '• ')
    .trim();
  $('#update-notes').textContent = notes || 'Исправления и улучшения.';
  $('#update-progress').hidden = true;
  const btn = $('#update-install');
  btn.disabled = false;
  btn.onclick = () => installUpdate(info);
  updateModal.hidden = false;
}

$('#update-close').addEventListener('click', () => { updateModal.hidden = true; });
updateModal.addEventListener('click', (e) => { if (e.target === updateModal) updateModal.hidden = true; });

// Startup check — non-blocking, silent on failure/offline
setTimeout(async () => {
  try {
    const info = await window.api.updateCheck();
    if (info && info.available) showUpdateModal(info);
  } catch (_e) { /* offline — skip */ }
}, 2500);
