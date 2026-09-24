const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('litChat', {
  openRooms:        () => ipcRenderer.send('ui:openRooms'),
  openLogs:         () => ipcRenderer.send('ui:openLogs'),
  getStatusHidden:  (jid) => ipcRenderer.invoke('status:getHidden', jid),
  setStatusHidden:  (jid, hidden) => ipcRenderer.invoke('status:setHidden', jid, hidden),
  dmHistory:        (username) => ipcRenderer.invoke('logs:dmHistory', username),
  openLitProfile:   () => ipcRenderer.send('ui:openLitProfile'),
  toggleAway:       () => ipcRenderer.invoke('prefs:toggleAway'),
  openStories:      () => ipcRenderer.send('ui:openStories'),
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
  // LitChat-owned ignore list (nick-keyed, applies in every room and in private chats)
  getIgnoreList:    () => ipcRenderer.invoke('ignore:list'),
  ignoreUser:       (nick) => ipcRenderer.invoke('ignore:add', nick),
  unignoreUser:     (nick) => ipcRenderer.invoke('ignore:remove', nick),
  importNativeIgnores: (nicks) => ipcRenderer.invoke('ignore:importNative', nicks),
  // Invisible LitChat-to-LitChat capability discovery (see injectCaps in main.js)
  capsSeen:         (nick, version) => ipcRenderer.invoke('caps:seen', nick, version),
  capsList:         () => ipcRenderer.invoke('caps:list'),
  capsHas:          (nick) => ipcRenderer.invoke('caps:has', nick),
  // Errors caught in the page (see injectStanzaGuard in main.js), for page-errors.log
  pageError:        (info) => ipcRenderer.send('page:error', info),
});
