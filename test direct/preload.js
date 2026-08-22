'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  geositeLoad: (payload) => ipcRenderer.invoke('geosite:load', payload),
  geositeDomains: (code) => ipcRenderer.invoke('geosite:domains', code),
  geositeSearch: (q) => ipcRenderer.invoke('geosite:search', q),
  geositeAddDomain: (payload) => ipcRenderer.invoke('geosite:addDomain', payload),
  geositeRemoveDomain: (payload) => ipcRenderer.invoke('geosite:removeDomain', payload),
  geoipLoad: (payload) => ipcRenderer.invoke('geoip:load', payload),
  geoipCidrs: (code) => ipcRenderer.invoke('geoip:cidrs', code),
  fetchText: (url) => ipcRenderer.invoke('net:fetchText', url),
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  openText: () => ipcRenderer.invoke('dialog:openText'),
  saveText: (payload) => ipcRenderer.invoke('dialog:saveText', payload),
  saveDat: (payload) => ipcRenderer.invoke('dialog:saveDat', payload),
  encodeDat: (payload) => ipcRenderer.invoke('dat:encode', payload),
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard:write', text)
});
