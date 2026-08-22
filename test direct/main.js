'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
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
    // Prefer an exact-name asset, else any .exe asset in the release.
    let asset = (rel.assets || []).find((a) => /\.exe$/i.test(a.name));
    if (!asset) return { available: false };
    return {
      available: true,
      version: latest,
      notes: typeof rel.body === 'string' ? rel.body.slice(0, 4000) : '',
      url: asset.browser_download_url,
      size: asset.size,
      name: asset.name
    };
  } catch (_e) {
    return { available: false };   // offline / rate-limited: silently skip
  }
}

function batEscape(p) { return p.replace(/%/g, '%%'); }

let updating = false;

async function performUpdate(downloadUrl, expectedSize, win) {
  if (updating) throw new Error('Обновление уже выполняется');
  updating = true;
  const selfPath = process.execPath;
  // In dev (`npm start`) electron.exe lives in node_modules — updating makes no sense.
  if (!/\.exe$/i.test(selfPath) || selfPath.includes('node_modules')) {
    updating = false;
    throw new Error('Обновление доступно только в установленной версии (.exe)');
  }
  const dir = path.dirname(selfPath);
  const tmpPath = path.join(dir, 'update-' + Date.now() + '.exe.new');
  const sendProgress = (label, pct) => {
    try { if (win && !win.isDestroyed()) win.webContents.send('update:progress', label, pct); } catch (_) {}
  };

  let buf;
  try {
    // Download in main: no CSP/CORS applies here. Stream to disk so a huge
    // file doesn't sit fully in memory, and relay progress for the UI bar.
    sendProgress('Скачивание…', 3);
    const res = await fetch(downloadUrl, {
      redirect: 'follow',
      headers: { 'User-Agent': 'RuleFlowEditor-Updater' }
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' при скачивании обновления');
    const total = Number(res.headers.get('content-length')) || expectedSize || 0;
    const reader = res.body.getReader();
    const fd = fs.openSync(tmpPath, 'w');
    let got = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fs.writeSync(fd, value);
        got += value.length;
        if (total > 0) {
          sendProgress('Скачивание… ' + Math.round((got / total) * 100) + '%', (got / total) * 92);
        } else {
          sendProgress('Скачивание… ' + (got / 1048576).toFixed(1) + ' МБ', Math.min(90, 4 + (got / 1048576)));
        }
      }
    } finally {
      fs.closeSync(fd);
    }
    // Integrity gates before anything destructive:
    if (expectedSize && got !== expectedSize) {
      throw new Error(`Файл скачан не полностью (${got} из ${expectedSize} байт). Попробуйте ещё раз.`);
    }
    if (!(buf = fs.readFileSync(tmpPath)).length) throw new Error('Пустой файл обновления');
    if (buf.length < 2 || buf[0] !== 0x4d || buf[1] !== 0x5a) {
      throw new Error('Скачанный файл не является приложением Windows (.exe)');
    }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    updating = false;
    throw err;
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
}

// Download a URL (follows redirects via global fetch), return Uint8Array
async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
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
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return await res.text();
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
  // payload: { url, size } — download happens HERE in main: the renderer's
  // fetch is blocked by CSP (default-src 'self' on a file:// page) and by
  // CORS on GitHub's release-asset redirect host. Progress is relayed to
  // the renderer via 'update:progress' webContents events.
  const url = String(payload && payload.url || '');
  const size = Number(payload && payload.size) || 0;
  if (!/^https:\/\/github\.com\/|^https:\/\/objects\.githubusercontent\.com\/|^https:\/\/release-assets\.githubusercontent\.com\//.test(url)) {
    throw new Error('Недопустимый URL обновления');
  }
  await performUpdate(url, size, e.sender);
  return true;
});

// Legacy byte-handoff path kept for compatibility; unused by the UI now.
ipcMain.handle('update:installBytes', async (_e, bytes) => {
  throw new Error('Этот способ установки больше не поддерживается');
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
