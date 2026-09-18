// Single source of truth for recognising photo/image messages in a chat body.
//
// Used in the main process and — via parsePhotoBody.toString() — injected into
// the Candy page as window._litParsePhoto, where both the DM-history renderer
// and the live-message enhancer call it. It must therefore stay completely
// self-contained: no closures, no requires, no references outside its body.
//
// Returns one of
//   { kind: 'native', url, whole }           Format A  "📷 https://picpub.art/hash.ext"
//   { kind: 'album', base, token, hash, vt,  Format B  "📷 View photo: https://picpub.art/v/TOKEN[?vt=CODE]#HASH"
//     fullUrl, litpicSrc, isVideo }
//   { kind: 'image', url }                   Format C  any direct image URL
//   null
//
// `whole` is true when the photo marker is the entire (trimmed) text, i.e.
// nothing else would be lost by replacing the text with the image.
// Only the FIRST photo in `text` is reported: callers must pass one message.
function parsePhotoBody(text) {
  text = String(text == null ? '' : text);

  var a = /\u{1F4F7} (https:\/\/picpub\.art\/[a-z0-9]+\.[a-z]+)(?=\s|$)/u.exec(text);
  if (a) {
    return { kind: 'native', url: a[1], whole: text.trim() === a[0].trim() };
  }

  var b = /\u{1F4F7} View photo: (https:\/\/picpub\.art\/v\/([a-f0-9]+)(?:\?[^#\s"'<>]*)?)#([\w.]+)/u.exec(text);
  if (b) {
    var vtM = /[?&]vt=([^&#]+)/.exec(b[1]);
    var vt = vtM ? vtM[1] : null;
    return {
      kind: 'album',
      base: b[1],
      token: b[2],
      hash: b[3],
      vt: vt,
      fullUrl: b[1] + '#' + b[3],
      litpicSrc: 'litpic://' + b[2] + '/' + b[3] + (vt ? '?vt=' + vt : ''),
      isVideo: /\.(?:mp4|webm|mov|mkv|avi)$/i.test(b[3]),
    };
  }

  var c = /(https?:\/\/[^\s<>"']+\.(?:jpg|jpeg|png|gif|webp)(?:\?[^\s<>"']*)?)/i.exec(text);
  if (c) return { kind: 'image', url: c[1] };

  return null;
}

module.exports = { parsePhotoBody };
