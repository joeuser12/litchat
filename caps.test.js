import { test, expect } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { loadCaps, saveCaps, recordCap, hasCap, forgetCap, normNick } = require('./caps');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'caps-')), 'peercaps.json');
}

test('normNick lowercases and trims', () => {
  expect(normNick('  AmyTraining ')).toBe('amytraining');
  expect(normNick(null)).toBe('');
});

test('recordCap stores display name but keys on the lowercased nick', () => {
  const m = new Map();
  expect(recordCap(m, ' AmyTraining ', '1')).toBe(true);
  expect(hasCap(m, 'amytraining')).toBe(true);
  expect(hasCap(m, 'AMYTRAINING')).toBe(true);
  expect(m.get('amytraining').name).toBe('AmyTraining');
});

test('recordCap reports a change only when the version differs', () => {
  const m = new Map();
  expect(recordCap(m, 'anaxbr', '1')).toBe(true);   // new peer
  expect(recordCap(m, 'anaxbr', '1')).toBe(false);  // repeat handshake, no disk write
  expect(recordCap(m, 'anaxbr', '2')).toBe(true);   // peer upgraded
});

test('recordCap ignores an empty nick', () => {
  const m = new Map();
  expect(recordCap(m, '   ', '1')).toBe(false);
  expect(m.size).toBe(0);
});

test('caps survive a save/load round trip', () => {
  const f = tmpFile();
  const m = new Map();
  recordCap(m, 'AmyTraining', '1');
  recordCap(m, 'anaxbr', '1');
  saveCaps(m, f);

  const back = loadCaps(f);
  expect(back.size).toBe(2);
  expect(back.get('amytraining').name).toBe('AmyTraining');
  expect(back.get('anaxbr').version).toBe('1');
  expect(typeof back.get('anaxbr').lastSeen).toBe('string');
});

test('a missing or corrupt file loads as an empty list rather than throwing', () => {
  expect(loadCaps(path.join(os.tmpdir(), 'definitely-not-here', 'peercaps.json')).size).toBe(0);
  const f = tmpFile();
  fs.writeFileSync(f, 'not json at all');
  expect(loadCaps(f).size).toBe(0);
});

test('forgetCap removes a peer regardless of case', () => {
  const m = new Map();
  recordCap(m, 'AmyTraining', '1');
  expect(forgetCap(m, 'AMYTRAINING')).toBe(true);
  expect(hasCap(m, 'amytraining')).toBe(false);
});
