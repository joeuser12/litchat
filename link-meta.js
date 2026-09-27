// Pulls the og:/meta/<title> fields a link preview needs out of a page's HTML.
// The HTML is untrusted and this runs on the main process, so nothing here may
// backtrack: tags are located with indexOf, and the one regex (attributes) only
// starts a match at the beginning of a name. The previous regexes took about an
// hour on a crafted 256 KB page of unclosed <meta property="og:title" tags.

// name=value pairs inside one tag; value double-, single- or un-quoted.
const ATTR = /(?<![\w:-])([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function tagsNamed(html, lower, name) {
  const tags = [];
  const open = '<' + name;
  let i = 0;
  while ((i = lower.indexOf(open, i)) !== -1) {
    const next = lower[i + open.length];
    if (next !== undefined && !/[\s/>]/.test(next)) { i += open.length; continue; }
    const end = lower.indexOf('>', i);
    if (end === -1) break;            // no later tag can close either
    tags.push({ start: i, end, text: html.slice(i, end + 1) });
    i = end + 1;
  }
  return tags;
}

// HTML entities in attribute values and <title>: numeric ones, and the named
// ones page titles actually use. Without this previews showed "Tom &amp; Jerry"
// and image URLs kept "&amp;" in their query strings.
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201c', rdquo: '\u201d', middot: '\u00b7', bull: '\u2022', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', laquo: '\u00ab', raquo: '\u00bb' };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

function parseLinkMeta(html) {
  const lower = html.toLowerCase();

  // First non-empty content per property/name, e.g. 'og:title', 'description'.
  const meta = new Map();
  for (const { text } of tagsNamed(html, lower, 'meta')) {
    const attrs = {};
    for (const m of text.matchAll(ATTR)) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4];
    const key = (attrs.property || attrs.name || '').toLowerCase();
    const content = decodeEntities(attrs.content || '').trim();
    if (key && content && !meta.has(key)) meta.set(key, content);
  }

  let docTitle = null;
  const [t] = tagsNamed(html, lower, 'title');
  if (t) {
    const close = lower.indexOf('</title', t.end);
    if (close !== -1) docTitle = decodeEntities(html.slice(t.end + 1, close)).trim().slice(0, 200) || null;
  }

  return {
    title:       meta.get('og:title') || docTitle,
    description: meta.get('og:description') || meta.get('description') || null,
    image:       meta.get('og:image') || null,
    siteName:    meta.get('og:site_name') || null,
  };
}

module.exports = { parseLinkMeta, decodeEntities };
