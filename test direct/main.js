'use strict';

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { parseGeoSiteList, parseGeoIPList } = require('./src/datparser');

// In-memory stores so the renderer stays light; domains served lazily per category.
let geositeStore = new Map();   // code -> [{type, value}]
let geoipStore = [];            // [{code, cidrs}]

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
}

// Download a URL (follows redirects via global fetch), return Uint8Array
async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  const ab = await res.arrayBuffer();
  return new Uint8Array(ab);
}

// ---- IPC ----

ipcMain.handle('geosite:load', async (_e, { url, fileData }) => {
  let buf;
  if (fileData) buf = new Uint8Array(fileData);
  else buf = await download(url);
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
  return geositeStore.get(code) || [];
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
  else buf = await download(url);
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

ipcMain.handle('dialog:openFile', async (_e, opts) => {
  const r = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: opts && opts.filters
  });
  if (r.canceled || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  const data = fs.readFileSync(p);
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

ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
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
