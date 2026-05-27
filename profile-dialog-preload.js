const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('profileDialog', {
  submit: (name) => ipcRenderer.send('profile:new-name', name),
  cancel: () => window.close(),
});
