import { test, expect } from 'bun:test';

const { buildChatContextMenu } = require('./context-menu');

const deps = () => {
  const copied = [];
  return { copied, deps: { copyText: t => copied.push(t) } };
};
const roles = t => t.filter(i => i.role).map(i => i.role);

test('offers nothing when there is nothing to copy or paste, so no empty menu pops up', () => {
  const { deps: d } = deps();
  expect(buildChatContextMenu({ isEditable: false, selectionText: '', linkURL: '' }, d)).toEqual([]);
});

test('a message box gets cut/copy/paste/select all, enabled from the edit flags', () => {
  const { deps: d } = deps();
  const t = buildChatContextMenu({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true } }, d);
  expect(roles(t)).toEqual(['cut', 'copy', 'paste', 'selectAll']);
  expect(t.find(i => i.role === 'paste').enabled).toBe(true);
  expect(t.find(i => i.role === 'cut').enabled).toBe(false);
  expect(t.find(i => i.role === 'copy').enabled).toBe(false);
});

test('missing edit flags disable the actions rather than throwing', () => {
  const { deps: d } = deps();
  const t = buildChatContextMenu({ isEditable: true }, d);
  expect(t.find(i => i.role === 'paste').enabled).toBe(false);
});

test('selected text outside an input offers copy and select all only', () => {
  const { deps: d } = deps();
  const t = buildChatContextMenu({ isEditable: false, selectionText: 'hello' }, d);
  expect(roles(t)).toEqual(['copy', 'selectAll']);
});

test('a link offers Copy Link Address, which copies exactly that URL', () => {
  const { copied, deps: d } = deps();
  const t = buildChatContextMenu({ linkURL: 'https://example.com/a?b=1' }, d);
  expect(t.map(i => i.label)).toEqual(['Copy Link Address']);
  t[0].click();
  expect(copied).toEqual(['https://example.com/a?b=1']);
});

test('a selected link separates the link item from the edit items, with no doubled or leading separators', () => {
  const { deps: d } = deps();
  const t = buildChatContextMenu({ linkURL: 'https://example.com', selectionText: 'x' }, d);
  expect(t.map(i => i.type === 'separator' ? '-' : (i.role || i.label))).toEqual(['Copy Link Address', '-', 'copy', 'selectAll']);
  expect(t[0].type).not.toBe('separator');
});

const { urlFromSelection } = require('./context-menu');

test('a selected address that is not a link is recognised', () => {
  expect(urlFromSelection('https://twitter.com/someone')).toBe('https://twitter.com/someone');
  expect(urlFromSelection('  see https://example.com/page). ')).toBe('https://example.com/page');
  expect(urlFromSelection('www.example.com')).toBe('https://www.example.com/');
  expect(urlFromSelection('example.com/page')).toBe('https://example.com/page');
  expect(urlFromSelection('myblog.blogspot.com')).toBe('https://myblog.blogspot.com/');
});

test('ordinary text, file names and other schemes get no Open item', () => {
  for (const t of ['', 'hello world', 'Michael', 'readme.md', 'photo.jpg', 'javascript:alert(1)', 'ftp://x.com', 'file:///etc/passwd'])
    expect(urlFromSelection(t)).toBeNull();
});

test('the chat window offers to open a selected address, in text and in editable fields', () => {
  const opened = [];
  const d = { copyText() {}, openUrl: u => opened.push(u) };
  const t = buildChatContextMenu({ selectionText: 'www.example.com/x' }, d);
  expect(t[0].label).toBe('Open "www.example.com/x" in Browser');
  t[0].click();
  expect(opened).toEqual(['https://www.example.com/x']);
  const inBox = buildChatContextMenu({ isEditable: true, selectionText: 'www.example.com', editFlags: {} }, d);
  expect(inBox[0].label).toBe('Open "www.example.com" in Browser');
});

test('pages that need the app\'s login are not offered for opening in the browser', () => {
  const { canOpenPageInBrowser } = require('./context-menu');
  expect(canOpenPageInBrowser('https://www.literotica.com/my/#/user/profile')).toBe(false);
  expect(canOpenPageInBrowser('https://www.literotica.com/my')).toBe(false);
  expect(canOpenPageInBrowser('https://auth.literotica.com/login')).toBe(false);
  expect(canOpenPageInBrowser('https://www.literotica.com/authors/someone')).toBe(true);
  expect(canOpenPageInBrowser('https://www.literotica.com/mystery-stories')).toBe(true);
  expect(canOpenPageInBrowser('https://example.com/my/page')).toBe(true);
  expect(canOpenPageInBrowser('about:blank')).toBe(false);
});
