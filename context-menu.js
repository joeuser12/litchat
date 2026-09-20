// Right-click menu for the main chat window. Electron gives a window no context
// menu of its own, so without this a right-click in the message box or on selected
// text did nothing, and there was no way to copy or paste with the mouse. (The
// link/profile pop-up windows build their own fuller menu in main.js.)
//
// Pure: takes Electron's context-menu `params` and returns a menu template, so it can
// be tested without a window. The caller supplies copyText so this needs no Electron.

// `template` entries use Electron menu roles (cut/copy/paste/selectAll) so the OS
// wires up the real clipboard actions. Returns [] when there is nothing to offer, in
// which case the caller should not pop up an empty menu.
function buildChatContextMenu(params, { copyText }) {
  const template = [];
  const sep = () => {
    if (template.length && template[template.length - 1].type !== 'separator') template.push({ type: 'separator' });
  };

  if (params.linkURL) {
    template.push({ label: 'Copy Link Address', click: () => copyText(params.linkURL) });
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

module.exports = { buildChatContextMenu };
