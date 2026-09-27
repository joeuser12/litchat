import { test, expect } from "bun:test";
const A = require('./away-reply');

const u = content => ({ role: 'user', content });
const a = content => ({ role: 'assistant', content });

test("initialHistory drops the logged copy of the message being answered", () => {
  expect(A.initialHistory([a('hi'), u('how are you?')], 'how are you?')).toEqual([a('hi')]);
  expect(A.initialHistory([a('hi'), u('earlier')], 'new one')).toEqual([a('hi'), u('earlier')]);
  expect(A.initialHistory([], 'x')).toEqual([]);
});

test("addToHistory keeps only the most recent messages", () => {
  const h = [];
  for (let i = 0; i < A.HISTORY_KEPT + 5; i++) A.addToHistory(h, u(String(i)));
  expect(h.length).toBe(A.HISTORY_KEPT);
  expect(h[0].content).toBe('5');
});

test("modelMessages sends a bounded, alternating history", () => {
  const h = [];
  for (let i = 0; i < 30; i++) h.push(i % 3 === 2 ? a('a' + i) : u('u' + i));
  const msgs = A.modelMessages('sys', h);
  expect(msgs[0]).toEqual({ role: 'system', content: 'sys' });
  for (let i = 2; i < msgs.length; i++) expect(msgs[i].role).not.toBe(msgs[i - 1].role);
  expect(msgs.slice(1).map(m => m.content).join('\n').split('\n').length).toBe(A.HISTORY_SENT);
});

test("gemma prompt: consecutive user DMs form one user turn", () => {
  const p = A.buildLlamaPrompt('gemma', [{ role: 'system', content: 'S' }, u('one'), u('two')]);
  expect(p).toBe('<start_of_turn>user\nS\n\none\ntwo<end_of_turn>\n<start_of_turn>model\n');
});

test("gemma prompt: history starting with our own reply keeps it in a model turn", () => {
  const p = A.buildLlamaPrompt('gemma', [{ role: 'system', content: 'S' }, a('earlier reply'), u('hi')]);
  expect(p).toBe(
    '<start_of_turn>user\nS<end_of_turn>\n' +
    '<start_of_turn>model\nearlier reply<end_of_turn>\n' +
    '<start_of_turn>user\nhi<end_of_turn>\n<start_of_turn>model\n');
});

test("chatml and qwen3 prompts", () => {
  expect(A.buildLlamaPrompt('chatml', [u('a'), u('b')]))
    .toBe('<|im_start|>user\na\nb<|im_end|>\n<|im_start|>assistant\n');
  expect(A.buildLlamaPrompt('qwen3', [{ role: 'system', content: 'S' }, u('a')]))
    .toBe('<|im_start|>system\nS<|im_end|>\n<|im_start|>user\na<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n');
});

test("replyDelay paces replies and stops at the session cap", () => {
  const now = 1_000_000;
  expect(A.replyDelay({ replies: 0 }, now)).toBe(0);
  expect(A.replyDelay({ replies: 1, lastReplyAt: now - 5000 }, now)).toBe(A.MIN_GAP_MS - 5000);
  expect(A.replyDelay({ replies: 1, inFlight: true }, now)).toBeNull();
  expect(A.replyDelay({ replies: 1, timer: {} }, now)).toBeNull();
  expect(A.replyDelay({ replies: A.MAX_REPLIES }, now)).toBeNull();
});
