const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('litChat', {
  openRooms:        () => ipcRenderer.send('ui:openRooms'),
  openLogs:         () => ipcRenderer.send('ui:openLogs'),
  getStatusHidden:  (jid) => ipcRenderer.invoke('status:getHidden', jid),
  setStatusHidden:  (jid, hidden) => ipcRenderer.invoke('status:setHidden', jid, hidden),
  dmHistory:        (username) => ipcRenderer.invoke('logs:dmHistory', username),
  openLitProfile:   () => ipcRenderer.send('ui:openLitProfile'),
  toggleAway:       () => ipcRenderer.invoke('prefs:toggleAway'),
  uploadPhoto:      (partnerUser, filePath, mimeType) =>
                      ipcRenderer.invoke('picpub:upload', partnerUser, filePath, mimeType),
  linkPhoto:        (partnerUser, url) =>
                      ipcRenderer.invoke('picpub:link', partnerUser, url),
  getViewerLink:    (token) =>
                      ipcRenderer.invoke('picpub:viewerLink', token),
  photoContextMenu: (token, hash) =>
                      ipcRenderer.invoke('picpub:contextMenu', token, hash),
  saveThumb:        (hash, dataUrl) =>
                      ipcRenderer.invoke('thumbs:save', hash, dataUrl),
  getLinkPreview:   (url) =>
                      ipcRenderer.invoke('links:preview', url),
  dmPhotos:         (username) =>
                      ipcRenderer.invoke('logs:dmPhotos', username),
  invoke:           (channel, ...args) => ipcRenderer.invoke(channel, ...args),
});
