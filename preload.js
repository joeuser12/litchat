const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('litChat', {
  openRooms:        () => ipcRenderer.send('ui:openRooms'),
  openLogs:         () => ipcRenderer.send('ui:openLogs'),
  getStatusHidden:  (jid) => ipcRenderer.invoke('status:getHidden', jid),
  setStatusHidden:  (jid, hidden) => ipcRenderer.invoke('status:setHidden', jid, hidden),
});
