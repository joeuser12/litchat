import { test, expect } from "bun:test";
const fs = require('fs');

// Much of main.js is page code in template strings passed to executeJavaScript.
// A syntax error there (say, a '\n' that should have been '\\n') only shows up as
// a silently missing feature in the running app. Build each inject*() script with
// a stub window and check that it parses.
const src = fs.readFileSync(__dirname + '/main.js', 'utf8');

function functionSource(name) {
  const start = src.indexOf(`function ${name}(`);
  let depth = 0, i = src.indexOf('{', start);
  for (;; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
}

const injectors = [...src.matchAll(/^function (inject\w+)\(\)/gm)].map(m => m[1]);

test("main.js has inject functions to check", () => {
  expect(injectors.length).toBeGreaterThan(5);
});

for (const name of injectors) {
  test(`${name}() injects code that parses`, () => {
    const scripts = [];
    // Stubs for what the injectors read from main.js's scope (a new module-level
    // name used by an injector needs one here too).
    const EMOJI_CATS_JSON = '[]';
    const MAX_UPLOAD_BYTES = 1;
    const win = { webContents: { executeJavaScript: s => { scripts.push(s); return Promise.resolve(); }, insertCSS: () => Promise.resolve('') } };
    const settings = { prefs: {}, theme: 'dark' };
    const isLightTheme = () => false;
    const { parsePhotoBody } = require('./media-parse');
    const console = { log() {}, warn() {}, error() {} };
    eval(functionSource(name) + `; ${name}();`);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
}
