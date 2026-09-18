const { test, expect } = require('bun:test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadIgnoreList, saveIgnoreList, addTo, removeFrom, normNick } = require('./ignore');

test('normNick trims and lowercases, tolerates junk', () => {
  expect(normNick('  Some_User ')).toBe('some_user');
  expect(normNick(null)).toBe('');
  expect(normNick(undefined)).toBe('');
});

test('add/remove are case-insensitive and report whether anything changed', () => {
  const m = new Map();
  expect(addTo(m, 'Ai_Joe')).toBe(true);
  expect(addTo(m, 'ai_joe')).toBe(false);      // already there
  expect(addTo(m, '   ')).toBe(false);         // empty
  expect(m.get('ai_joe')).toBe('Ai_Joe');      // display name kept as first given
  expect(removeFrom(m, 'AI_JOE')).toBe(true);
  expect(removeFrom(m, 'ai_joe')).toBe(false);
  expect(m.size).toBe(0);
});

test('nicks with spaces and odd characters survive', () => {
  const m = new Map();
  addTo(m, 'Big Bad Wolf');
  addTo(m, "o'neil-99");
  expect(m.has('big bad wolf')).toBe(true);
  expect(m.has("o'neil-99")).toBe(true);
});

test('save/load round trip; missing or corrupt file is an empty list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lit-ignore-'));
  const file = path.join(dir, 'sub', 'ignorelist.json');
  expect(loadIgnoreList(file).size).toBe(0);
  const m = new Map();
  addTo(m, 'Zed'); addTo(m, 'alpha');
  saveIgnoreList(m, file);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(['alpha', 'Zed']);
  const back = loadIgnoreList(file);
  expect([...back.keys()].sort()).toEqual(['alpha', 'zed']);
  fs.writeFileSync(file, '{not json');
  expect(loadIgnoreList(file).size).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});
