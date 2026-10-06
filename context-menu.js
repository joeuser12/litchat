// Right-click menu for the main chat window. Electron gives a window no context
// menu of its own, so without this a right-click in the message box or on selected
// text did nothing, and there was no way to copy or paste with the mouse. (The
// link/profile pop-up windows build their own fuller menu in main.js.)
//
// Pure: takes Electron's context-menu `params` and returns a menu template, so it can
// be tested without a window. The caller supplies copyText so this needs no Electron.

// A web address in selected text that isn't a link: a Literotica profile's bio,
// for one, shows URLs as plain text, and the menu then had no way to open them
// ("Open This Page in Browser" opens the profile itself). Takes the first full
// http(s) URL in the selection, or a selection that is only a domain with an
// optional path, which gets https:// (www.example.com, example.com/page). A bare
// name must start with www., have a path, or end in a common web domain ending,
// so "readme.md" or "photo.jpg" don't get an Open item. Returns null otherwise.
const WEB_ENDINGS = 'com|net|org|io|co|uk|us|ca|au|nz|ie|de|fr|nl|be|it|es|se|no|dk|fi|pl|eu|me|tv|info|biz|xyz|app|dev|link|ly|gg|fm|to|blog|site|online|art';
const BARE_DOMAIN = new RegExp(
  '^(?:www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+(?:[/?#]\\S*)?' +                 // www.anything
  '|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.[a-z]{2,}[/?#]\\S*' +                     // domain + path
  '|[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:' + WEB_ENDINGS + '))$', 'i');        // common ending
function urlFromSelection(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return null;
  const strip = u => u.replace(/[.,;:!?)\]'">]+$/, '');
  const httpUrl = u => {
    try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; }
    catch { return null; }
  };
  const full = /https?:\/\/[^\s<>"']+/i.exec(t);
  if (full) return httpUrl(strip(full[0]));
  if (/\s/.test(t)) return null;
  const bare = strip(t);
  return BARE_DOMAIN.test(bare) ? httpUrl('https://' + bare) : null;
}

// False for Literotica pages that only work while logged in: the /my/ control
// panel (the toolbar's Profile button opens its profile editor) and the login
// server. The user's web browser isn't logged in, so "Open This Page in Browser"
// there only showed "control-panel-couldnt-load … You are not authorized" and
// then the site's login page.
function canOpenPageInBrowser(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const lit = u.hostname === 'literotica.com' || u.hostname.endsWith('.literotica.com');
  if (lit && (u.pathname === '/my' || u.pathname.startsWith('/my/'))) return false;
  if (u.hostname === 'auth.literotica.com') return false;
  return true;
}

// A URL short enough for a menu label.
function menuLabelUrl(u) {
  const s = u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return s.length > 45 ? s.slice(0, 44) + '\u2026' : s;
}

// `template` entries use Electron menu roles (cut/copy/paste/selectAll) so the OS
// wires up the real clipboard actions. Returns [] when there is nothing to offer, in
// which case the caller should not pop up an empty menu.
function buildChatContextMenu(params, { copyText, openUrl }) {
  const template = [];
  const sep = () => {
    if (template.length && template[template.length - 1].type !== 'separator') template.push({ type: 'separator' });
  };

  if (params.linkURL) {
    template.push({ label: 'Copy Link Address', click: () => copyText(params.linkURL) });
  } else if (openUrl) {
    // Also inside editable text: the profile editor shows the bio's links there.
    const url = urlFromSelection(params.selectionText);
    if (url) template.push({ label: `Open "${menuLabelUrl(url)}" in Browser`, click: () => openUrl(url) });
  }

  if (params.isEditable) {
    sep();
    const flags = params.editFlags || {};
    template.push(
      { role: 'cut', enabled: !!flags.canCut },
      { role: 'copy', enabled: !!flags.canCopy },
      { role: 'paste', enabled: !!flags.canPaste },
      { role: 'selectAll' },
    );
  } else if (params.selectionText) {
    sep();
    template.push({ role: 'copy' }, { role: 'selectAll' });
  }

  return template;
}

module.exports = { buildChatContextMenu, urlFromSelection, menuLabelUrl, canOpenPageInBrowser };
