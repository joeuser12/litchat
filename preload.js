const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('litChat', {
  openRooms:        () => ipcRenderer.send('ui:openRooms'),
  openLogs:         () => ipcRenderer.send('ui:openLogs'),
  getStatusHidden:  (jid) => ipcRenderer.invoke('status:getHidden', jid),
  setStatusHidden:  (jid, hidden) => ipcRenderer.invoke('status:setHidden', jid, hidden),
  dmHistory:        (username) => ipcRenderer.invoke('logs:dmHistory', username),
  openLitProfile:   () => ipcRenderer.send('ui:openLitProfile'),
  toggleAway:       () => ipcRenderer.invoke('prefs:toggleAway'),
  // Uploads stream to the main process in slices: N × uploadChunk(uploadId, bytes),
  // then uploadPhoto(…, uploadId) commits them; uploadAbort discards on failure.
  uploadChunk:      (uploadId, chunk) => ipcRenderer.invoke('picpub:uploadChunk', uploadId, chunk),
  uploadAbort:      (uploadId) => ipcRenderer.invoke('picpub:uploadAbort', uploadId),
  uploadPhoto:      (partnerUser, fileName, mimeType, uploadId) =>
                      ipcRenderer.invoke('picpub:upload', partnerUser, fileName, mimeType, uploadId),
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
});
