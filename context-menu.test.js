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
