// Pure parts of the LLM away-reply (llama-server / OpenRouter): conversation
// history, prompt building and pacing. The network calls stay in main.js.

const HISTORY_KEPT  = 40;          // messages remembered per sender
const HISTORY_SENT  = 20;          // of those, how many go to the model
const MIN_GAP_MS    = 20_000;      // per sender, between two replies
const MAX_REPLIES   = 25;          // per sender, per away session

// Starting history from the logs. logger.js writes a received message before
// notifyDMs handles it, so the logged history already ends with the message
// being answered; drop it there, because the caller appends it itself.
function initialHistory(logged, userText) {
  const h = logged.slice();
  const last = h[h.length - 1];
  if (last && last.role === 'user' && last.content === userText) h.pop();
  return h;
}

function addToHistory(history, entry) {
  history.push(entry);
  if (history.length > HISTORY_KEPT) history.splice(0, history.length - HISTORY_KEPT);
}

// Several DMs in a row from one side become one turn: chat templates expect
// user and assistant turns to alternate.
function mergeTurns(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += '\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

// What goes to the model: optional system prompt plus the recent turns.
function modelMessages(systemPrompt, history) {
  return [
    ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
    ...mergeTurns(history.slice(-HISTORY_SENT)),
  ];
}

// Raw completion prompt for llama-server's /completion endpoint.
function buildLlamaPrompt(arch, messages) {
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  const turns = mergeTurns(messages.filter(m => m.role !== 'system'));

  if (arch === 'gemma') {
    // Gemma has no system role: the system prompt opens the first user turn.
    let prompt = '';
    let pendingSystem = system;
    if (pendingSystem && (turns[0]?.role !== 'user')) {
      prompt += `<start_of_turn>user\n${pendingSystem}<end_of_turn>\n`;
      pendingSystem = '';
    }
    for (const t of turns) {
      const role = t.role === 'assistant' ? 'model' : 'user';
      let content = t.content;
      if (role === 'user' && pendingSystem) { content = `${pendingSystem}\n\n${content}`; pendingSystem = ''; }
      prompt += `<start_of_turn>${role}\n${content}<end_of_turn>\n`;
    }
    return prompt + '<start_of_turn>model\n';
  }

  // ChatML — covers Qwen3, Llama-3, Mistral, Phi, etc.
  let prompt = system ? `<|im_start|>system\n${system}<|im_end|>\n` : '';
  for (const t of turns) prompt += `<|im_start|>${t.role}\n${t.content}<|im_end|>\n`;
  // Qwen3: an empty think block skips chain-of-thought.
  return prompt + (arch === 'qwen3' ? '<|im_start|>assistant\n<think>\n\n</think>\n\n' : '<|im_start|>assistant\n');
}

// How long to wait before the next reply to this sender may be generated, or
// null if none may (one already running or queued, or the session cap is hit).
// Pacing and the cap keep two away-mode LitChat users, or a spammer, from
// running an endless and costly reply loop.
function replyDelay(state, now) {
  if (state.inFlight || state.timer || state.replies >= MAX_REPLIES) return null;
  return Math.max(0, (state.lastReplyAt || 0) + MIN_GAP_MS - now);
}

module.exports = {
  HISTORY_KEPT, HISTORY_SENT, MIN_GAP_MS, MAX_REPLIES,
  initialHistory, addToHistory, mergeTurns, modelMessages, buildLlamaPrompt, replyDelay,
};
