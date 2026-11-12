/**
 * Boot watchdog behaviour.
 *
 * Extracts the inline watchdog from index.html and runs it against a tiny DOM,
 * because the bundled-game test cannot cover it: it is page markup, not part of
 * the JS bundle. This guards a real false alarm — a failed Cloudflare analytics
 * beacon (injected by the preview host) raised "A game script failed to load"
 * over a game that had started perfectly well behind it.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

// Pull out the inline script that defines the watchdog (the one mentioning it).
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .filter((code) => code.includes('__aetherisBooted') || code.includes('gameHasBooted'));
if (scripts.length !== 1) {
  console.error(`✗ expected exactly one inline watchdog script, found ${scripts.length}`);
  process.exit(1);
}
const watchdog = scripts[0];

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

/** Run the watchdog in a fresh sandbox and return its control surface. */
function boot({ booted = false, loadStatus = 'Awakening', origin = 'http://127.0.0.1:5173' } = {}) {
  const listeners = {};
  const fatal = { shown: false, msg: '', classList: { add() { fatal.shown = true; } } };
  const status = { textContent: loadStatus };
  const timers = [];

  const sandbox = {
    window: {
      __aetherisBooted: booted,
      addEventListener(type, cb) { (listeners[type] ||= []).push(cb); },
    },
    document: {
      getElementById(id) {
        if (id === 'fatal') return { querySelector: () => ({ set textContent(v) { fatal.msg = v; } }), classList: fatal.classList };
        if (id === 'loadStatus') return status;
        return null;
      },
    },
    location: { href: origin + '/', origin },
    URL,
    setTimeout(fn) { timers.push(fn); },
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.window.location = sandbox.location;
  vm.createContext(sandbox);
  vm.runInContext(watchdog, sandbox);

  return {
    fatal, status, timers,
    fire(type, event) {
      for (const cb of listeners[type] || []) cb({ preventDefault() {}, ...event });
    },
    bootedLater() { sandbox.window.__aetherisBooted = true; },
  };
}

console.log('\n▸ boot watchdog');

// 1. The false alarm that shipped: third-party analytics failing while the game
//    is running fine.
{
  const w = boot({ booted: true });
  w.fire('error', { target: { tagName: 'SCRIPT', src: 'https://static.cloudflareinsights.com/beacon.min.js' }, message: '' });
  check('third-party script failure is ignored', !w.fatal.shown);
  check('loader text is left alone', w.status.textContent === 'Awakening', w.status.textContent);
}

// 2. A third-party script failing is ignored even mid-boot, because the game
//    may still be loading its own files.
{
  const w = boot({ booted: false });
  w.fire('error', { target: { tagName: 'SCRIPT', src: 'https://example.com/extension.js' }, message: '' });
  check('foreign script failure during boot is ignored', !w.fatal.shown);
}

// 3. Our own script failing is a genuine problem and must be reported.
{
  const w = boot({ booted: false });
  w.fire('error', { target: { tagName: 'SCRIPT', src: 'http://127.0.0.1:5173/src/game/fighter.js' }, message: '' });
  check('own-origin script failure is reported', w.fatal.shown);
  check('the failing file is named', w.fatal.msg.includes('/src/game/fighter.js'), w.fatal.msg.split('\n')[0]);
}

// 4. The stale-module symptom gets its own plain-language advice.
{
  const w = boot({ booted: false });
  w.fire('error', { message: "The requested module does not provide an export named 'weaponHands'" });
  check('stale-module error suggests a hard reload', w.fatal.shown && /ctrl\+shift\+r/i.test(w.fatal.msg));
}

// 5. Once the game has booted, nothing is reported over it.
{
  const w = boot({ booted: true });
  w.fire('error', { message: 'some later script error' });
  check('errors after a successful boot do not raise the card', !w.fatal.shown);
}

// 6. A dead server still gets reported instead of a silent freeze.
{
  const w = boot({ booted: false });
  w.timers.forEach((fn) => fn());
  check('never starting is reported after the timeout', w.fatal.shown);
  check('the message says it did not start', /did not start/i.test(w.fatal.msg));
}

// 7. ...but not if the game did boot.
{
  const w = boot({ booted: false });
  w.bootedLater();
  w.timers.forEach((fn) => fn());
  check('a booted game is not accused of not starting', !w.fatal.shown);
}

/*
 * 8. The shipped payload must run its bundle after the DOM exists.
 *
 * This is the regression that shipped twice: the inliner replaced Vite's
 * deferred `<script type="module">` in <head> with an immediate classic
 * `<script>`, so the game ran while document.body was still null. The result
 * was a loading screen frozen on "Awakening" with *no* crash card, because the
 * card's own element did not exist yet either. Both checks below would have
 * caught it.
 */
if (fs.existsSync(path.join(ROOT, 'release', 'Aetheris.html'))) {
  const payload = fs.readFileSync(path.join(ROOT, 'release', 'Aetheris.html'), 'utf8');
  const bodyAt = payload.search(/<body[^>]*>/i);
  const closeAt = payload.search(/<\/body\s*>/i);

  const scriptsInHead = (payload.slice(0, bodyAt).match(/<script(?![^>]*\stype=)/gi) || []).length;
  check('no classic script runs in <head>', scriptsInHead === 0, `${scriptsInHead} found`);

  const bundleAt = payload.indexOf('<script>');
  check('the game bundle is parsed inside <body>', bundleAt > bodyAt && bundleAt < closeAt);

  // The `$&` bug: a replacement string containing `$&` spliced the matched
  // `</body>` into the middle of the minified game code.
  const scripts = [...payload.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const broken = scripts.find((code) => /<\/body>|<body/.test(code));
  check('no markup was spliced into the bundle', !broken);

  let parses = true;
  for (const code of scripts) {
    try { new vm.Script(code); } catch { parses = false; }
  }
  check('every inline script parses', parses, `${scripts.length} script(s)`);
}

console.log(`\n${fail === 0 ? '✅' : '❌'} watchdog: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
