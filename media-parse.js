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

  var b = /\u{1F4F7} View photo: (https:\/\/picpub\.art\/v\/([a-f0-9]+)(?:\?[^#\s"'<>]*)?)#(\w+(?:\.\w+)*)/u.exec(text);
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

  // Format C, word by word: one regex over the whole text re-scanned the rest of
  // it from every "http" (quadratic on long messages), and matched inside longer
  // URLs ("photo.jpg.html" became an image at "photo.jpg"). Sentence punctuation
  // after the URL is not part of it. The query string is split off with indexOf so
  // nothing here backtracks.
  var words = text.split(/\s+/);
  for (var i = 0; i < words.length; i++) {
    var start = words[i].search(/https?:\/\//i);
    if (start === -1) continue;
    var url = words[i].slice(start).replace(/[.,;:!?)\]'"]+$/, '');
    var q = url.indexOf('?');
    var base = q === -1 ? url : url.slice(0, q);
    if (/^https?:\/\/[^<>"'?]+\.(?:jpg|jpeg|png|gif|webp)$/i.test(base) &&
        (q === -1 || /^\?[^<>"']*$/.test(url.slice(q)))) {
      return { kind: 'image', url: url };
    }
  }

  return null;
}

module.exports = { parsePhotoBody };
