'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const { parseGeoSiteList, parseGeoIPList, encodeGeoSiteList, encodeGeoIPList } = require('./src/datparser');

// In-memory stores so the renderer stays light; domains served lazily per category.
let geositeStore = new Map();   // code -> [{type, value}]
let geoipStore = [];            // [{code, cidrs}]

// ---- Auto-update (GitHub Releases) ----
// The distributed build is a single portable .exe named RuleFlowEditor-<version>.exe.
// Update flow: fetch latest release → compare semver → on demand download the
// new exe in the MAIN process (CSP/CORS-free, with progress relayed to the
// renderer over IPC) next to the running one → spawn cmd script that waits for
// this process to exit, replaces the old exe (keeping the old install
// path/name), starts the new version and deletes itself.
const UPDATER_REPO = 'iosmastertg-commits/Happ-RoutingEditor';
let updateWin = null;            // window to receive update:progress events

// Hosts that may serve an update binary. Checked by exact hostname (not by URL
// prefix: `^https://github.com/` would also match github.com/<anyone>/<anything>)
// and re-checked on every redirect hop, since a redirect off an allowed host
// would otherwise smuggle in an arbitrary download.
const UPDATE_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
]);
const MAX_UPDATE_BYTES = 300 * 1024 * 1024;   // sanity cap; the real exe is ~71 MB

// Set to true once release binaries are code-signed. Until then a signature
// check would reject every legitimate update, so it stays opt-in.
const REQUIRE_SIGNATURE = false;

// The asset chosen by the last successful checkForUpdate(). The install step
// reads the URL from HERE instead of accepting one over IPC — otherwise a
// compromised renderer picks the binary that overwrites our own .exe.
let lastUpdate = null;

function isAllowedUpdateUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' && UPDATE_HOSTS.has(p.hostname);
  } catch (_e) {
    return false;
  }
}

// fetch() with redirect: 'manual' so each hop's host is validated.
async function fetchAllowed(url, init) {
  let current = url;
  for (let hop = 0; hop < 6; hop++) {
    if (!isAllowedUpdateUrl(current)) throw new Error('Недопустимый URL обновления');
    const res = await fetch(current, Object.assign({}, init, { redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error('Редирект без Location при скачивании обновления');
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new Error('Слишком много редиректов при скачивании обновления');
}

function cmpSemver(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${UPDATER_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'RuleFlowEditor-Updater' },
      redirect: 'follow'
    });
    if (!res.ok) return { available: false };
    const rel = await res.json();
    if (!rel || !rel.tag_name || Array.isArray(rel)) return { available: false };
    const latest = rel.tag_name.replace(/^v/i, '');
    const current = app.getVersion();
    if (cmpSemver(latest, current) <= 0) return { available: false };
    // Prefer the exact expected filename; only then fall back to any .exe.
    const assets = rel.assets || [];
    const wanted = `RuleFlowEditor-${latest}.exe`.toLowerCase();
    let asset = assets.find((a) => String(a.name).toLowerCase() === wanted)
      || assets.find((a) => /\.exe$/i.test(a.name));
    if (!asset) return { available: false };
    if (!isAllowedUpdateUrl(asset.browser_download_url)) return { available: false };
    // Optional checksum manifest published alongside the exe.
    const sumsAsset = assets.find((a) => /^sha256sums(\.txt)?$/i.test(a.name))
      || assets.find((a) => /\.sha256$/i.test(a.name));
    lastUpdate = {
      version: latest,
      url: asset.browser_download_url,
      size: asset.size,
      name: asset.name,
      sumsUrl: sumsAsset && isAllowedUpdateUrl(sumsAsset.browser_download_url)
        ? sumsAsset.browser_download_url
        : null
    };
    return {
      available: true,
      version: latest,
      notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
      size: asset.size,
      name: asset.name
    };
  } catch (_e) {
    return { available: false };   // offline / rate-limited: silently skip
  }
}

function batEscape(p) { return p.replace(/%/g, '%%'); }

let updating = false;

// Parse a `sha256sums`-style manifest ("<hex>  <filename>" per line) and return
// the digest recorded for `name`, or null when the file isn't listed.
function digestFromSums(text, name) {
  const target = String(name).toLowerCase();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (m && m[2].trim().toLowerCase().replace(/^\.\//, '') === target) return m[1].toLowerCase();
  }
  // A bare `<file>.sha256` often holds just the digest.
  const only = String(text).trim().match(/^([a-f0-9]{64})$/i);
  return only ? only[1].toLowerCase() : null;
}

// Ask Windows whether the binary carries a valid Authenticode signature.
function verifyAuthenticode(filePath) {
  return new Promise((resolve) => {
    const ps = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    execFile(
      ps,
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-AuthenticodeSignature -LiteralPath ${JSON.stringify(filePath)}).Status`],
      { windowsHide: true, timeout: 30000 },
      (err, stdout) => resolve(!err && String(stdout).trim() === 'Valid')
    );
  });
}

// `asset` is the entry cached by checkForUpdate() — never a renderer-supplied URL.
async function performUpdate(asset, win) {
  if (updating) throw new Error('Обновление уже выполняется');
  updating = true;
  let tmpPath = null;
  try {
    const selfPath = process.execPath;
    // In dev (`npm start`) electron.exe lives in node_modules — updating makes no sense.
    if (!/\.exe$/i.test(selfPath) || selfPath.includes('node_modules')) {
      throw new Error('Обновление доступно только в установленной версии (.exe)');
    }
    const expectedSize = Number(asset.size) || 0;
    const dir = path.dirname(selfPath);
    tmpPath = path.join(dir, 'update-' + Date.now() + '.exe.new');
    const sendProgress = (label, pct) => {
      try { if (win && !win.isDestroyed()) win.webContents.send('update:progress', label, pct); } catch (_) {}
    };

    // Download in main: no CSP/CORS applies here. Stream to disk so a huge
    // file doesn't sit fully in memory, and relay progress for the UI bar.
    sendProgress('Скачивание…', 3);
    const res = await fetchAllowed(asset.url, {
      headers: { 'User-Agent': 'RuleFlowEditor-Updater' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' при скачивании обновления');
    const total = Number(res.headers.get('content-length')) || expectedSize || 0;
    if (total > MAX_UPDATE_BYTES) throw new Error('Файл обновления слишком велик');
    const reader = res.body.getReader();
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(tmpPath, 'w');
    let got = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        // Cap mid-stream too: content-length can lie or be absent.
        if (got > MAX_UPDATE_BYTES) throw new Error('Файл обновления слишком велик');
        fs.writeSync(fd, value);
        hash.update(value);
        if (total > 0) {
          sendProgress('Скачивание… ' + Math.round((got / total) * 100) + '%', (got / total) * 92);
        } else {
          sendProgress('Скачивание… ' + (got / 1048576).toFixed(1) + ' МБ', Math.min(90, 4 + (got / 1048576)));
        }
      }
    } finally {
      fs.closeSync(fd);
    }

    // Integrity gates before anything destructive. expectedSize comes from the
    // GitHub API via lastUpdate, so it can't be zeroed out to skip this.
    if (expectedSize && got !== expectedSize) {
      throw new Error(`Файл скачан не полностью (${got} из ${expectedSize} байт). Попробуйте ещё раз.`);
    }
    if (!got) throw new Error('Пустой файл обновления');
    const head = Buffer.alloc(2);
    const rfd = fs.openSync(tmpPath, 'r');
    try { fs.readSync(rfd, head, 0, 2, 0); } finally { fs.closeSync(rfd); }
    if (head[0] !== 0x4d || head[1] !== 0x5a) {
      throw new Error('Скачанный файл не является приложением Windows (.exe)');
    }

    // Checksum, when the release publishes one.
    if (asset.sumsUrl) {
      sendProgress('Проверка контрольной суммы…', 94);
      const sres = await fetchAllowed(asset.sumsUrl, {
        headers: { 'User-Agent': 'RuleFlowEditor-Updater' }
      });
      if (!sres.ok) throw new Error('Не удалось получить контрольную сумму обновления');
      const expected = digestFromSums(await sres.text(), asset.name);
      if (!expected) throw new Error('Контрольная сумма для ' + asset.name + ' не найдена');
      const actual = hash.digest('hex');
      if (actual !== expected) {
        throw new Error('Контрольная сумма не совпадает — файл повреждён или подменён');
      }
    }

    if (REQUIRE_SIGNATURE) {
      sendProgress('Проверка подписи…', 96);
      if (!(await verifyAuthenticode(tmpPath))) {
        throw new Error('Цифровая подпись обновления недействительна');
      }
    }

    // Batch script: wait for the app to exit → replace exe under its CURRENT name
    // → start it → delete temp + self. ping is used instead of `timeout` because
    // timeout fails under redirected stdin and would hot-spin the loop.
    sendProgress('Установка — приложение сейчас перезапустится…', 97);
    const batPath = path.join(dir, 'ruleflow-update-' + Date.now() + '.cmd');
    const script = [
      '@echo off',
      ':waitloop',
      `tasklist /FI "PID eq ${process.pid}" | find /I "${process.pid}" >nul`,
      'if not errorlevel 1 (',
      '  ping -n 2 127.0.0.1 >nul',
      '  goto waitloop',
      ')',
      `move /y "${batEscape(tmpPath)}" "${batEscape(selfPath)}" >nul`,
      // Replacement failed: leave the .new file for a retry and don't relaunch
      // over a half-written exe.
      'if errorlevel 1 (',
      `  start "" "${batEscape(selfPath)}"`,
      `  del "%~f0"`,
      '  exit /b 1',
      ')',
      `if exist "${batEscape(tmpPath)}" del "${batEscape(tmpPath)}"`,
      `start "" "${batEscape(selfPath)}"`,
      `del "%~f0"`
    ].join('\r\n');
    fs.writeFileSync(batPath, script);

    // Detach: the batch outlives us after we quit. stdio ignored so no pipe
    // handles keep the parent alive; cmd.exe resolved from SystemRoot.
    const cmdExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    const child = execFile(cmdExe, ['/c', batPath], { windowsHide: true, detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 300);   // give IPC reply time to reach renderer
  } catch (err) {
    // Any failure leaves no partial download behind and lets the user retry:
    // the flag must not stay set or every later attempt reports "already running".
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
    updating = false;
    throw err;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: '#0e1116',
    title: 'Rule Flow Editor',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  updateWin = win;
  // The app is a single local page: no navigation, no spawned windows. A
  // compromised renderer must not be able to open remote content (which would
  // inherit these webPreferences, preload included) or phish in-app.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// ---- Outbound request guards (renderer-supplied URLs) ----
// The main process is not bound by CSP or CORS, so any URL the renderer hands
// us is fetched with full network reach — including the loopback interface,
// RFC1918 ranges and the cloud metadata address. Everything below exists to
// keep a renderer-controlled URL from reaching a host the user never intended.

const MAX_FETCH_BYTES = 64 * 1024 * 1024;   // geosite.dat is ~10 MB; leave headroom
const FETCH_TIMEOUT_MS = 30000;

function ip4IsPrivate(a, b) {
  if (a === 0 || a === 10 || a === 127) return true;              // this-network, private, loopback
  if (a === 169 && b === 254) return true;                        // link-local incl. 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16/12
  if (a === 192 && b === 168) return true;                        // 192.168/16
  if (a === 192 && b === 0) return true;                          // 192.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
  if (a === 198 && (b === 18 || b === 19)) return true;            // benchmarking 198.18/15
  if (a >= 224) return true;                                      // multicast + reserved
  return false;
}

function isPrivateAddress(addr) {
  const s = String(addr).toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n > 255)) return true;   // malformed: refuse rather than guess
    return ip4IsPrivate(p[0], p[1]);
  }
  if (s === '::1' || s === '::' || s === '0:0:0:0:0:0:0:1') return true;
  // IPv4-mapped/compatible — dotted tail (::ffff:127.0.0.1) or HEX groups
  // (::ffff:7f00:1). Judge the embedded address either way.
  const mapped = s.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateAddress(mapped[1]);
  const mappedHex = s.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
    return ip4IsPrivate((hi >> 8) & 0xff, hi & 0xff);
  }
  if (/^f[cd]/.test(s)) return true;           // fc00::/7 unique-local
  if (/^fe[89ab]/.test(s)) return true;        // fe80::/10 link-local
  return false;
}

// Resolve the hostname and reject if ANY answer is internal. Without this a
// public name pointed at 127.0.0.1 would sail past a textual check.
async function assertPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_e) { throw new Error('Некорректный URL'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('Поддерживаются только http и https');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('Запрос к локальному адресу запрещён');
  }
  // No textual fast-path: shorthand (127.1), DWORD (2130706433) and hex IPv6
  // (::ffff:7f00:1) literals all evade regex checks but resolve internally.
  // dns.lookup canonicalizes every literal form, so run ALL hosts through it.
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (_e) {
    throw new Error('Не удалось разрешить имя хоста: ' + host);
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Имя хоста указывает на внутренний адрес');
  }
  return u;
}

// fetch with: per-hop URL validation, wall-clock timeout, hard byte ceiling.
// Redirects are followed manually so a public URL can't bounce to an internal one.
async function fetchGuarded(rawUrl, { limitBytes = MAX_FETCH_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let current = String(rawUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicHttpUrl(current);
      const res = await fetch(current, { redirect: 'manual', signal: ac.signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Редирект без Location');
        current = new URL(loc, current).toString();
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
      const declared = Number(res.headers.get('content-length'));
      if (declared && declared > limitBytes) {
        throw new Error('Файл слишком велик (' + Math.round(declared / 1048576) + ' МБ)');
      }
      // Stream so an undeclared or lying content-length can't exhaust memory.
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (got > limitBytes) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error('Файл превышает допустимый размер (' + Math.round(limitBytes / 1048576) + ' МБ)');
        }
        chunks.push(value);
      }
      const out = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      return out;
    }
    throw new Error('Слишком много редиректов');
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('Превышено время ожидания запроса');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Download a URL, return Uint8Array. Size- and time-bounded; internal hosts refused.
async function download(url) {
  return fetchGuarded(url);
}

// Users paste github.com "blob" page links; those return HTML, not the file.
// Rewrite them to raw.githubusercontent.com so the bytes are the real asset.
function normalizeGithubUrl(url) {
  const m = url.match(/^https?:\/\/(?:www\.)?github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+)$/i);
  if (!m) return url;
  return 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4];
}

// ---- IPC ----

ipcMain.handle('geosite:load', async (_e, { url, fileData }) => {
  let buf;
  if (fileData) buf = new Uint8Array(fileData);
  else buf = await download(normalizeGithubUrl(url));
  const categories = parseGeoSiteList(buf);
  geositeStore = new Map();
  const meta = [];
  for (const c of categories) {
    const key = c.code.toUpperCase();
    if (geositeStore.has(key)) {
      geositeStore.get(key).push(...c.domains);
    } else {
      geositeStore.set(key, c.domains.slice());
    }
  }
  for (const [code, domains] of geositeStore) {
    meta.push({ code, count: domains.length });
  }
  meta.sort((a, b) => a.code.localeCompare(b.code));
  return { categories: meta };
});

ipcMain.handle('geosite:domains', async (_e, code) => {
  // store keys are uppercased at load; rules may carry lowercase codes (geosite:cn)
  return geositeStore.get(String(code || '').toUpperCase()) || [];
});

// Bulk "is this whole category already covered?" check for the Geofiles tab.
// Previously the renderer pulled every category's domains over IPC one request
// at a time just to compare them — on a real geosite.dat (~1000 categories)
// that shipped the entire .dat across the bridge on every render, and again on
// every single item added. The comparison happens here instead; only one
// boolean per code goes back.
ipcMain.handle('geo:coveredBy', async (_e, payload) => {
  const kind = payload && payload.kind === 'geoip' ? 'geoip' : 'geosite';
  const codes = Array.isArray(payload && payload.codes) ? payload.codes : [];
  const haveList = Array.isArray(payload && payload.have) ? payload.have : [];
  const have = new Set(haveList.map((v) => String(v).toLowerCase()));
  const out = {};
  for (const raw of codes) {
    const code = String(raw || '');
    let items;
    if (kind === 'geoip') {
      const c = geoipStore.find((x) => x.code.toUpperCase() === code.toUpperCase());
      items = c ? c.cidrs : [];
    } else {
      items = geositeStore.get(code.toUpperCase()) || [];
    }
    // An empty category is reported as not covered, matching the old UI.
    out[code] = items.length > 0
      && items.every((it) => have.has(String(kind === 'geoip' ? it : it.value).toLowerCase()));
  }
  return out;
});

// Full-content search: find every category that has a domain matching `q`.
// Returns [{ code, total, matches: [{type, value}] }] limited per category.
ipcMain.handle('geosite:search', async (_e, q) => {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const [code, domains] of geositeStore) {
    const matches = [];
    for (const d of domains) {
      if (d.value.toLowerCase().includes(needle)) {
        if (matches.length < 200) matches.push(d);
      }
    }
    if (matches.length) out.push({ code, total: domains.length, matches });
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  return out;
});

ipcMain.handle('geosite:addDomain', async (_e, { code, type, value }) => {
  const list = geositeStore.get(code);
  if (list) list.push({ type: type || 'domain', value });
  return true;
});

ipcMain.handle('geosite:removeDomain', async (_e, { code, index }) => {
  const list = geositeStore.get(code);
  if (list && index >= 0 && index < list.length) list.splice(index, 1);
  return true;
});

ipcMain.handle('geoip:load', async (_e, { url, fileData }) => {
  let buf;
  if (fileData) buf = new Uint8Array(fileData);
  else buf = await download(normalizeGithubUrl(url));
  geoipStore = parseGeoIPList(buf);
  const countries = geoipStore
    .map((c) => ({ code: c.code.toUpperCase(), count: c.cidrs.length }))
    .sort((a, b) => a.code.localeCompare(b.code));
  return { countries };
});

ipcMain.handle('geoip:cidrs', async (_e, code) => {
  const c = geoipStore.find((x) => x.code.toUpperCase() === String(code || '').toUpperCase());
  return c ? c.cidrs : [];
});

ipcMain.handle('net:fetchText', async (_e, url) => {
  // Guarded: the renderer picks this URL, and main would otherwise reach
  // loopback/RFC1918/metadata hosts and hand the body back (SSRF).
  const bytes = await fetchGuarded(normalizeGithubUrl(String(url || '')), { limitBytes: 16 * 1024 * 1024 });
  return Buffer.from(bytes).toString('utf-8');
});

// Encode custom categories (Geofiles tab) into a V2Ray .dat byte array.
ipcMain.handle('dat:encode', async (_e, { kind, categories }) => {
  const buf = kind === 'geoip'
    ? encodeGeoIPList(categories)
    : encodeGeoSiteList(categories);
  return Array.from(buf);
});

ipcMain.handle('dialog:openFile', async (_e, opts) => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: opts && opts.filters
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const data = fs.readFileSync(p); // throws propagate to renderer's catch → error toast
  return { path: p, data: Array.from(data) };
});

ipcMain.handle('dialog:openText', async () => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Rules', extensions: ['txt', 'json', 'conf', 'list'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'Text', extensions: ['txt', 'conf', 'list'] },
      { name: 'All', extensions: ['*'] }
    ]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return fs.readFileSync(r.filePaths[0], 'utf-8');
});

ipcMain.handle('dialog:saveText', async (_e, { defaultName, content }) => {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName || 'rules.txt',
    filters: [{ name: 'Text', extensions: ['txt'] }]
  });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, content, 'utf-8');
  return true;
});

// Save a binary .dat file (geosite/geoip) produced by the Geofiles tab.
ipcMain.handle('dialog:saveDat', async (_e, { defaultName, buffer }) => {
  const r = await dialog.showSaveDialog({
    defaultPath: defaultName || 'geosite.dat',
    filters: [{ name: 'V2Ray dat', extensions: ['dat'] }]
  });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, Buffer.from(buffer));
  return true;
});

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

// ---- Auto-update IPC ----
ipcMain.handle('update:check', async () => {
  return checkForUpdate();
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('update:install', async (e, payload) => {
  // payload: { version } only. The download URL is NOT accepted from the
  // renderer — main re-derives it from the release it verified itself, so a
  // compromised renderer can't choose the binary that replaces our .exe.
  // The download runs here because the renderer's fetch is blocked by CSP
  // (default-src 'self' on a file:// page) and by CORS on GitHub's asset host.
  // Progress is relayed back via 'update:progress' webContents events.
  const wantVersion = String(payload && payload.version || '');
  if (!lastUpdate) await checkForUpdate();
  if (!lastUpdate) throw new Error('Обновление не найдено');
  // Guard against a stale modal asking for a version we no longer offer.
  if (wantVersion && wantVersion !== lastUpdate.version) {
    throw new Error('Версия обновления изменилась, проверьте обновление заново');
  }
  await performUpdate(lastUpdate, e.sender);
  return true;
});

// Legacy byte-handoff path kept for compatibility; unused by the UI now.
ipcMain.handle('update:installBytes', async (_e, bytes) => {
  throw new Error('Этот способ установки больше не поддерживается');
});

// Single instance: two copies racing to overwrite the same .exe would corrupt
// the install. The second launch just focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (updateWin && !updateWin.isDestroyed()) {
      if (updateWin.isMinimized()) updateWin.restore();
      updateWin.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
