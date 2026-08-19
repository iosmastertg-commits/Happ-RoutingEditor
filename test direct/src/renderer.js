'use strict';

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

/* ============================ Helpers ============================ */
const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

function ruleKey(type, value) {
  return type + ':' + String(value).trim().toLowerCase();
}
function formatRule(r) {
  return r.type === 'plain' ? r.value : r.type + ':' + r.value;
}
function parseLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
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
      if (p && p.value.trim()) {
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

function toast(msg, kind) {
  const wrap = $('#toast-wrap');
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), msg);
  wrap.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 250);
  }, 2200);
}

/* ============================ App tabs ============================ */
document.querySelectorAll('.app-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.app-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    $('#view-editor').hidden = view !== 'editor';
    $('#view-converter').hidden = view !== 'converter';
    if (view === 'converter') {
      renderConvSrcList();
      updateConvTabCounts();
    }
  });
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
  const frag = document.createDocumentFragment();
  for (const r of list) {
    const li = convRuleEl(r.type, r.value);
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
  const ok = await window.api.saveText({ defaultName: 'rules.txt', content });
  if (ok) toast('Экспортировано в файл', 'ok');
});

$('#conv-src-export-json').addEventListener('click', async () => {
  if (!state.rules.length) return toast('Нечего экспортировать', 'err');
  const content = JSON.stringify(buildExportJson(), null, 2);
  const ok = await window.api.saveText({ defaultName: 'rules.json', content });
  if (ok) toast('Экспортировано в JSON', 'ok');
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
  const ok = await window.api.saveText({ defaultName: 'converted-rules.txt', content: lines.join('\n') + '\n' });
  if (ok) toast('Экспортировано в файл', 'ok');
});

$('#conv-export-json').addEventListener('click', async () => {
  if (!convertedJson) return toast('Сначала нажмите «Конвертировать»', 'err');
  const ok = await window.api.saveText({ defaultName: 'converted-rules.json', content: JSON.stringify(convertedJson, null, 2) });
  if (ok) toast('Экспортировано в JSON', 'ok');
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

function refreshAddedKeys() {
  state.addedKeys = new Set(state.rules.map((r) => ruleKey(r.type, r.value)));
}

function syncMarks() {
  // geosite circles
  document.querySelectorAll('.dom').forEach((d) => {
    const key = d.dataset.key;
    const on = state.addedKeys.has(key);
    d.classList.toggle('added', on);
    const c = d.querySelector('.circle');
    if (c) { c.classList.toggle('on', on); c.textContent = on ? '✓' : '+'; }
  });
  // geoip tiles
  document.querySelectorAll('.tile').forEach((t) => {
    t.classList.toggle('added', state.addedKeys.has(t.dataset.key));
  });
  // geosite categories
  document.querySelectorAll('.cat').forEach((c) => {
    const on = state.addedKeys.has(c.dataset.geokey);
    c.classList.toggle('cat-added', on);
    const b = c.querySelector('.cat-add');
    if (b) b.textContent = on ? '✓ geosite' : '+ geosite';
  });
}

function updateRulesCount() {
  const count = state.rules.filter(r => r.section === state.currentSection).length;
  $('#rules-count').textContent = count;
  $('#rules-empty').style.display = count ? 'none' : 'block';
  // update tab badges
  document.querySelectorAll('.section-tab').forEach((tab) => {
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
  const key = ruleKey(type, value);
  if (state.addedKeys.has(key)) {
    // already exists — flash it
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
  const rule = { id: ruleSeq++, type, value, section: opts.section || state.currentSection };
  state.rules.push(rule);
  state.addedKeys.add(key);
  if (rule.section === state.currentSection) {
    const node = createRuleEl(rule);
    rulesList.appendChild(node);
    if (opts.flash) node.classList.add('flash');
  }
  updateRulesCount();
  if (!opts.batch) syncMarks();
  if (type === 'geosite') dedupeGeosite(value);
  return rule;
}

async function dedupeGeosite(catCode) {
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
  const dupes = state.rules.filter((r) => r.type === 'domain' && vals.has(r.value.trim().toLowerCase()));
  if (!dupes.length) return;
  dupes.forEach((r) => removeRule(r.id));
  toast('Удалено дублей под geosite:' + catCode + ': ' + dupes.length, 'ok');
}

function removeRule(id) {
  const idx = state.rules.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const rule = state.rules[idx];
  state.rules.splice(idx, 1);
  state.addedKeys.delete(ruleKey(rule.type, rule.value));
  const node = [...rulesList.children].find((c) => c._id === id);
  if (node) {
    node.classList.add('removing');
    setTimeout(() => node.remove(), 270);
  }
  updateRulesCount();
  setTimeout(syncMarks, 0);
}

function renderRulesList() {
  rulesList.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const r of state.rules) {
    if (r.section === state.currentSection) {
      const el = createRuleEl(r);
      el.classList.add('new-batch');
      frag.appendChild(el);
    }
  }
  rulesList.appendChild(frag);
  requestAnimationFrame(() => {
    document.querySelectorAll('.rule.new-batch').forEach((n) => n.classList.remove('new-batch'));
  });
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
      state.addedKeys.delete(ruleKey(rule.type, rule.value));
      rule.value = nv;
      li._key = ruleKey(rule.type, rule.value);
      refreshAddedKeys();
      syncMarks();
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
  const content = state.rules.map(formatRule).join('\n') + '\n';
  const ok = await window.api.saveText({ defaultName: 'rules.txt', content });
  if (ok) toast('Экспортировано в файл', 'ok');
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
  const ok = await window.api.saveText({ defaultName: 'rules.json', content });
  if (ok) toast('Экспортировано в JSON', 'ok');
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
  const text = await window.api.openText();
  if (text != null) {
    $('#import-textarea').value = text;
    document.querySelector('.modal-tabs .tab[data-tab="text"]').click();
    toast('Файл загружен — проверьте текст', 'ok');
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
    syncMarks();
    updateRulesCount();
    renderConvSrcList();
    updateConvTabCounts();
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
  const seen = new Set();
  const toAdd = parseJsonImport(jsonObj).filter((p) => {
    const key = ruleKey(p.type, p.value);
    if (state.addedKeys.has(key) || seen.has(key)) return false;
    seen.add(key);
    state.addedKeys.add(key);
    return true;
  });
  if (!toAdd.length) { toast('Не найдено правил в Direct секциях JSON', 'err'); return false; }
  return importRules(toAdd);
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
    if (replace) {
      state.rules = [];
      state.addedKeys.clear();
      rulesList.innerHTML = '';
    }
    const ok = await applyJsonImport(jsonObj);
    if (ok) importModal.hidden = true;
    return;
  }

  const text = $('#import-textarea').value;
  if (replace) {
    state.rules = [];
    state.addedKeys.clear();
    rulesList.innerHTML = '';
  }
  const jsonObj = tryParseJson(text);
  if (jsonObj && typeof jsonObj === 'object' && !Array.isArray(jsonObj)) {
    const ok = await applyJsonImport(jsonObj);
    if (ok) importModal.hidden = true;
    return;
  }
  const toAdd = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line) => {
    const p = parseLine(line);
    if (p && p.value.trim()) {
      const key = ruleKey(p.type, p.value);
      if (!state.addedKeys.has(key)) {
        state.addedKeys.add(key);
        toAdd.push(p);
      }
    }
  });
  const ok = await importRules(toAdd);
  if (ok) importModal.hidden = true;
});

/* ============================ Geosite column ============================ */
const geositeTree = $('#geosite-tree');

$('#geosite-load').addEventListener('click', loadGeosite);
$('#geosite-file').addEventListener('click', async () => {
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
    if (/^https?:\/\//i.test(url)) payload = { url };
    else { // treat as local file path -> open dialog instead
      const f = await window.api.openFile({ filters: [{ name: 'dat', extensions: ['dat'] }] });
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
  if (state.addedKeys.has(catKey)) { wrap.classList.add('cat-added'); addBtn.textContent = '✓ geosite'; }

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
      // toggle off
      const r = state.rules.find((x) => ruleKey(x.type, x.value) === catKey);
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

  const circle = el('div', 'circle', state.addedKeys.has(key) ? '✓' : '+');
  if (state.addedKeys.has(key)) { circle.classList.add('on'); row.classList.add('added'); }
  const dtype = el('span', 'dtype', d.type);
  const val = el('span', 'val', d.value);
  val.title = d.value;
  const del = el('button', 'ddel', '🗑');
  del.title = 'Удалить домен из категории';

  row.append(circle, dtype, val, del);

  const addThis = () => {
    if (addRule(ruleType, d.value, { flash: true })) {
      syncMarks();
      toast('Добавлено: ' + d.value, 'ok');
    }
  };
  circle.addEventListener('click', addThis);

  del.addEventListener('click', async (e) => {
    e.stopPropagation();
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
  const f = await window.api.openFile({ filters: [{ name: 'GeoIP dat', extensions: ['dat'] }] });
  if (!f) return;
  const res = await window.api.geoipLoad({ fileData: f.data });
  state.geoipMeta = res.countries;
  state.geoipSource = f.path.split('\\').pop();
  renderGeoipTiles();
  const status = $('#geoip-status');
  status.className = 'status ok';
  status.textContent = `Загружен файл: ${f.path.split('\\').pop()} — стран: ${res.countries.length}`;
});
$('#geoip-filter').addEventListener('input', renderGeoipTiles);

async function loadGeoip() {
  const url = $('#geoip-url').value.trim();
  const status = $('#geoip-status');
  status.className = 'status';
  status.innerHTML = 'Загрузка <span class="spin">⟳</span>';
  try {
    let payload;
    if (/^https?:\/\//i.test(url)) payload = { url };
    else {
      const f = await window.api.openFile({ filters: [{ name: 'dat', extensions: ['dat'] }] });
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
      // toggle off if already present
      const r = state.rules.find((x) => ruleKey(x.type, x.value) === key);
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
document.querySelectorAll('.section-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.section-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.currentSection = tab.dataset.section;
    renderRulesList();
    updateRulesCount();
    syncMarks();
  });
});

/* ============================ Init ============================ */
updateRulesCount();
