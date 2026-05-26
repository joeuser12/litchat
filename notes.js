const fs = require('fs');
const path = require('path');

const NOTES_FILE = path.join(process.env.LIT_USERDATA || __dirname, 'logs', 'notes.json');

function load() {
  try { return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8')); }
  catch { return {}; }
}

function readNote(username) {
  return load()[username.toLowerCase()] || '';
}

function saveNote(username, text) {
  const notes = load();
  const key = username.toLowerCase();
  if (text.trim()) notes[key] = text.trim();
  else delete notes[key];
  fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

module.exports = { readNote, saveNote };
