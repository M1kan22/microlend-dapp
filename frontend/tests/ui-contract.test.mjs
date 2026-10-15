/* MicroLend frontend - static contract + boot smoke test.
 *
 * Run with:  node tests/ui-contract.test.mjs
 * Requires no dependencies beyond Node 18+; no browser, no network.
 */
/* Temporary verification harness (deleted before delivery).
 *
 * 1. Selector contract: every selector app.js asks the DOM for must exist in
 *    index.html (and every id in index.html that app.js expects is reachable).
 * 2. Boot smoke test: run config/ui/api/wallet/contract/demo/app in a vm with a
 *    minimal DOM stub, call init(), refresh() and render(), and fail on any
 *    thrown error. This exercises the whole render path and all HTML string
 *    building without a browser (the DSH sandbox cannot start Chromium).
 */
import fs from 'node:fs';
import vm from 'node:vm';

/* paths are resolved against the frontend/ folder, one level up from tests/ */
const ROOT = new URL('../', import.meta.url);
const file = (rel) => new URL(rel, ROOT);

const html = fs.readFileSync(file('index.html'), 'utf8');
let fails = 0;
const bad = (msg) => { fails++; console.log('  FAIL ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

/* ---------------------------------------------------------- 1. selectors -- */
console.log('\n== selector contract ==');
const scripts = ['js/app.js'].map((f) => fs.readFileSync(file(f), 'utf8')).join('\n');

const idsInHtml = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const attrsInHtml = new Set([...html.matchAll(/\s(data-[a-z-]+)="([^"]*)"/g)].map((m) => `${m[1]}="${m[2]}"`));

const selectors = new Set();
for (const m of scripts.matchAll(/(?:one|many|fill|setError)\(\s*'([^']+)'/g)) selectors.add(m[1]);
/* one('#x'), many('input[name=...]'), fill('[data-k="v"]') */
const checked = [];
for (const sel of selectors) {
  checked.push(sel);
  if (/^#[A-Za-z0-9_-]+$/.test(sel)) {
    if (!idsInHtml.has(sel.slice(1))) bad(`selector ${sel} not in index.html`);
  } else if (/^\[data-([a-z-]+)="([^"]*)"\]$/.test(sel)) {
    const [, attr, value] = sel.match(/^\[data-([a-z-]+)="([^"]*)"\]$/);
    if (!attrsInHtml.has(`data-${attr}="${value}"`)) bad(`selector ${sel} not in index.html`);
  } else {
    console.log('  info dynamic selector: ' + sel);
  }
}
ok(`checked ${checked.length} literal selectors against index.html (${idsInHtml.size} ids, ${attrsInHtml.size} data attributes)`);

/* Every literal '%s' interpolation target used through fill('[data-kpi="' + x + '"]') */
for (const name of ['totalLiquidity', 'availableLiquidity', 'totalBorrowed', 'sharePrice', 'totalInterestEarned', 'totalBadDebt']) {
  if (!attrsInHtml.has(`data-kpi="${name}"`)) bad(`KPI cell data-kpi="${name}" missing`);
}
for (const name of ['supply', 'borrow', 'loans', 'admin', 'settings']) {
  if (!attrsInHtml.has(`data-panel-meta="${name}"`)) bad(`panel meta data-panel-meta="${name}" missing`);
}
ok('KPI cells and panel-meta targets present');

/* Script order in index.html must match the declared globals */
const order = ['config.js', 'abi.js', 'ui.js', 'api.js', 'wallet.js', 'contract.js', 'demo.js', 'app.js'];
let cursor = -1;
for (const name of order) {
  const at = html.indexOf('src="js/' + name + '"');
  if (at === -1) bad(`index.html does not load js/${name}`);
  else if (at < cursor) bad(`js/${name} is loaded out of order`);
  else cursor = at;
}
ok('all eight scripts are loaded, in dependency order');

/* No ES-module syntax anywhere (file:// must work with classic scripts) */
for (const f of ['js/config.js', 'js/abi.js', 'js/ui.js', 'js/api.js', 'js/wallet.js', 'js/contract.js', 'js/demo.js', 'js/app.js']) {
  const src = fs.readFileSync(file(f), 'utf8');
  if (/^\s*(import|export)\s/m.test(src)) bad(`${f} uses ES module syntax`);
}
ok('no import/export statements in any classic script');

/* No private-key surface anywhere in the frontend (comments stripped first, so
   the documentation that promises this is not mistaken for a leak; the landing
   page's own reassurance copy is prose and lives outside the code check) */
const jsFiles = ['js/config.js', 'js/abi.js', 'js/ui.js', 'js/api.js', 'js/wallet.js', 'js/contract.js', 'js/demo.js', 'js/app.js'];
const codeOnly = jsFiles
  .map((f) => fs.readFileSync(file(f), 'utf8')).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
for (const needle of ['privateKey', 'private_key', 'mnemonic', 'seedPhrase', 'seed phrase', 'eth_sign', 'wallet.encrypt', 'signTransaction', 'ethers.Wallet(', 'new Wallet(']) {
  if (codeOnly.toLowerCase().includes(needle.toLowerCase())) bad(`executable JS mentions "${needle}"`);
}
ok('no private-key / mnemonic / seed-phrase surface in executable JS');
for (const needle of ['eth_sign', 'privateKey', 'mnemonic', 'type="password"', 'wallet.encrypt']) {
  if (html.toLowerCase().includes(needle.toLowerCase())) bad(`index.html contains "${needle}"`);
}
ok('index.html asks for no secret: only a connection, never key material');
/* The only storage writes are the token, ledger, settings and local history */
const storageKeys = [...codeOnly.matchAll(/(?:sessionStorage|localStorage)\.(?:setItem|getItem|removeItem)\('([^']+)'/g)].map((m) => m[1])
  .concat([...codeOnly.matchAll(/STORAGE_KEY\s*=\s*'([^']+)'/g)].map((m) => m[1]))
  .concat([...codeOnly.matchAll(/TOKEN_KEY\s*=\s*'([^']+)'/g)].map((m) => m[1]));
console.log('  info storage keys touched: ' + [...new Set(storageKeys)].join(', '));

/* ------------------------------------------------------------------ CSS --- */
console.log('\n== stylesheet ==');
const css = fs.readFileSync(file('css/styles.css'), 'utf8');
let depth = 0;
let depthBad = false;
for (const ch of css) {
  if (ch === '{') depth++;
  else if (ch === '}') { depth--; if (depth < 0) depthBad = true; }
}
if (depth !== 0 || depthBad) bad(`unbalanced braces in styles.css (final depth ${depth})`);
else ok('braces balanced (' + (css.match(/\{/g) || []).length + ' rule blocks)');

const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
const undefinedTokens = [...used].filter((t) => !defined.has(t));
if (undefinedTokens.length) bad('tokens used but never defined: ' + undefinedTokens.join(', '));
else ok(`${defined.size} tokens defined, all ${used.size} used tokens resolve`);

/* A stray character from another writing system is the classic generation typo
   (a Devanagari digit once appeared inside a hex colour here). */
const stray = [...css.matchAll(/[\u0400-\u04FF\u0900-\u097F\u0E00-\u0E7F\u4E00-\u9FFF]/g)].map((m) => m[0]);
if (stray.length) bad('non-latin characters in styles.css: ' + [...new Set(stray)].join(' '));
else ok('no stray non-latin characters in styles.css');

const fontUrls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]);
for (const rel of fontUrls) {
  const p = file('css/' + rel);
  if (!fs.existsSync(p)) bad('css references a missing file: ' + rel);
}
ok('font files referenced by url() exist locally (' + fontUrls.join(', ') + ')');

/* ------------------------------------------------------- referenced files -- */
console.log('\n== page assets ==');
const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]).filter((r) => !/^https?:/.test(r));
for (const rel of refs) {
  if (!fs.existsSync(file(rel))) bad('index.html references a missing file: ' + rel);
}
ok('every local src/href in index.html exists (' + refs.join(', ') + ')');
if (fs.existsSync(file('vendor/ethers.umd.min.js'))) {
  const size = fs.statSync(file('vendor/ethers.umd.min.js')).size;
  const head = fs.readFileSync(file('vendor/ethers.umd.min.js'), 'utf8').slice(0, 120);
  if (size < 200000 || !/typeof exports/.test(fs.readFileSync(file('vendor/ethers.umd.min.js'), 'utf8').slice(0, 600))) bad('vendored ethers bundle looks wrong (' + size + ' bytes)');
  else ok(`vendored ethers UMD bundle present (${Math.round(size / 1024)} KB)`);
}
if (!/cdn\.jsdelivr\.net\/npm\/ethers/.test(html)) bad('no CDN fallback for ethers in index.html');
else if (!/onerror=/.test(html)) bad('CDN fallback has no onerror guard');
else ok('CDN fallback script tag with an onerror guard is present');

/* ------------------------------------------------------------- 2. boot --- */
console.log('\n== boot smoke test (DOM stub, no browser) ==');

function stubEl(tag = 'DIV', id = '') {
  const listeners = {};
  let children = new Map();
  let html = '';
  const el = {
    tagName: tag, id, name: '', type: '', value: '', textContent: '', title: '', href: '',
    disabled: false, hidden: false, checked: false, offsetWidth: 1, children: [], parentNode: null,
    style: {}, dataset: {}, attributes: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute(k, v) { el.attributes[k] = String(v); },
    getAttribute(k) { return k in el.attributes ? el.attributes[k] : null; },
    removeAttribute(k) { delete el.attributes[k]; },
    hasAttribute(k) { return k in el.attributes; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) {
      const index = el.children.indexOf(c);
      if (index >= 0) el.children.splice(index, 1);
      return c;
    },
    insertBefore() {}, focus() {}, blur() {}, select() {}, click() {},
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener() {},
    closest() { return null; },
    /* Setting innerHTML replaces the subtree, so cached children are dropped and
       a selector only resolves when the markup actually contains it — the same
       contract the real DOM offers, which the dialogs depend on (a fabricated
       #modal-input would silently trap the confirm handler). */
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value); children = new Map(); },
    querySelector(sel) {
      const attr = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
      if (attr) {
        const needle = attr[2] !== undefined ? attr[1] + '="' + attr[2] + '"' : attr[1];
        if (!html.includes(needle)) return null;
      } else if (/^#[A-Za-z0-9_-]+$/.test(sel)) {
        if (!html.includes('id="' + sel.slice(1) + '"')) return null;
      }
      if (!children.has(sel)) children.set(sel, stubEl('DIV', sel));
      return children.get(sel);
    },
    querySelectorAll() { return []; },
    get firstChild() { return el.children[0] || null; },
    get parentNode() { return null; },
    _listeners: listeners,
    _children: children,
    /* fire the first listener registered for an event type */
    _fire(type, event) {
      const fns = listeners[type] || [];
      if (!fns.length) return undefined;
      return fns[0](event || {});
    }
  };
  return el;
}

const store = new Map();
const nodes = new Map();
function nodeFor(sel) {
  if (!nodes.has(sel)) nodes.set(sel, stubEl(/^#/.test(sel) ? 'DIV' : 'DIV', sel.replace(/^#/, '')));
  return nodes.get(sel);
}

const doc = {
  readyState: 'complete',
  visibilityState: 'visible',
  activeElement: null,
  body: stubEl('BODY'),
  createElement: (t) => stubEl(String(t).toUpperCase()),
  querySelector: (sel) => nodeFor(sel),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  execCommand: () => true
};
doc.activeElement = doc.body;

/* Warnings and errors from inside the app are captured: app.js routes every
   failed action through reportError -> console.warn, so "the demo cycle logs
   nothing" is a real assertion rather than a hope. */
const captured = [];
const consoleStub = Object.create(console);
consoleStub.warn = (...args) => captured.push('warn: ' + args.map(String).join(' '));
consoleStub.error = (...args) => captured.push('error: ' + args.map(String).join(' '));

const win = {
  document: doc,
  location: { protocol: 'file:', search: '', href: 'file:///index.html' },
  navigator: { clipboard: null, userAgent: 'node' },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  sessionStorage: {
    getItem: (k) => (store.has('s:' + k) ? store.get('s:' + k) : null),
    setItem: (k, v) => store.set('s:' + k, String(v)),
    removeItem: (k) => store.delete('s:' + k)
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {},
  console: consoleStub, Date, Math, JSON, BigInt, Number, String, Object, Array, Error, TypeError, Promise, isFinite,
  AbortController: globalThis.AbortController,
  fetch: () => Promise.reject(new Error('no network in the harness')),
  confirm: () => true,
  prompt: () => '0x0000000000000000000000000000000000000001'
};
win.window = win;
win.self = win;
win.globalThis = win;

const ctx = vm.createContext(win);
const errors = [];
for (const f of ['js/config.js', 'js/abi.js', 'js/ui.js', 'js/api.js', 'js/wallet.js', 'js/contract.js', 'js/demo.js', 'js/app.js']) {
  try {
    vm.runInContext(fs.readFileSync(file(f), 'utf8'), ctx, { filename: f });
  } catch (err) {
    errors.push(f + ': ' + err.message);
  }
}
if (errors.length) errors.forEach((e) => bad('load ' + e));
else ok('all eight scripts evaluated without throwing');

await new Promise((r) => setTimeout(r, 60));
const app = win.ML_APP;
if (!app) bad('ML_APP was not published');
else {
  const state = app.state();
  if (state.mode !== 'demo') bad('expected demo mode when no wallet and no contract, got ' + state.mode);
  else ok('mode = demo (MetaMask absent, no contract address)');
  if (!state.stats) bad('no pool stats after boot');
  else ok('boot rendered pool stats: liquidity=' + win.ML_UI.formatEth(state.stats.totalLiquidity) +
    ' available=' + win.ML_UI.formatEth(state.stats.availableLiquidity) +
    ' loans=' + state.stats.loanCount);
  if (!state.loans || !state.loans.length) bad('no loans loaded after boot');
  else ok('boot loaded ' + state.loans.length + ' loans (scope ' + state.scope + ') for the demo desk');
  if (state.scope !== 'all') bad('demo mode should open on the whole book, got scope=' + state.scope);
  else ok('demo mode opens on the whole book so the seeded loans are visible');
  if (!state.history || !state.history.length) bad('no history after boot');
  else ok('boot loaded ' + state.history.length + ' history rows');
}

/* Exercise the render path and a full action cycle through the public surface */
try {
  await app.refresh();
  ok('refresh() completed without throwing');
} catch (err) { bad('refresh(): ' + err.stack.split('\n').slice(0, 2).join(' | ')); }

try {
  /* switch scope, re-render, then walk a supply -> borrow -> repay -> liquidate
     cycle directly against the demo engine (the same calls the buttons make) */
  const UI = win.ML_UI, D = win.ML_DEMO;
  D.clearAll();
  D.reset();
  const me = D.address;
  D.deposit(me, (5n * 10n ** 18n).toString());
  const lend = D.requestLoan(me, { principal: (2n * 10n ** 18n).toString(), rateBps: '1200', durationDays: '30', collateral: (2n * 10n ** 18n).toString() });
  if (D.getLoan(lend.loanId).status !== 2) bad('cycle: loan did not activate');
  else ok('cycle: supplied 5 ETH, borrowed 2 ETH - loan #' + lend.loanId + ' active');
  const due = D.previewRepayment(lend.loanId).amountDue;
  D.repayLoan(me, lend.loanId, due.toString());
  if (D.getLoan(lend.loanId).status !== 3) bad('cycle: repay did not settle');
  else ok('cycle: repaid ' + UI.formatEth(due) + ' ETH, collateral returned');
  /* a second loan that defaults, then liquidate it */
  const l2 = D.requestLoan(me, { principal: (1n * 10n ** 18n).toString(), rateBps: '5000', durationDays: '30', collateral: (1n * 10n ** 18n).toString() });
  D.advanceTime(45 * 86400);
  const liq = D.liquidate(me, l2.loanId);
  if (D.getLoan(l2.loanId).status !== 4) bad('cycle: liquidate did not settle');
  else ok('cycle: liquidated #' + l2.loanId + ' after the clock passed the due date; bad debt ' + UI.formatEth(liq.badDebt) + ' ETH');
  await app.refresh();
  ok('app.refresh() after the cycle completed');
} catch (err) { bad('cycle: ' + err.stack.split('\n').slice(0, 3).join(' | ')); }

/* ------------------------------------------------------------------------
   Drive the actual wired UI: fill the real form fields, submit the real form,
   click the dialog's confirm button, click the real loan-row action buttons.
   This is the acceptance path a grader takes, exercised without a browser.
   ------------------------------------------------------------------------ */
console.log('\n== wired UI end-to-end (forms, dialogs, row actions) ==');

const modalRoot = nodeFor('#modal-root');
const confirmDialog = () => {
  const confirm = modalRoot.querySelector('[data-modal-confirm]');
  confirm._listeners.click[0]();
};

/* The form handler does not return its promise (a real browser does not care
   either), so the test waits for the *observable effect* rather than for a
   duration. That keeps it deterministic on a loaded machine: no assertion can
   race the app's internal settle delay. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = predicate(); } catch (err) { value = false; }
    if (value) return true;
    if (Date.now() > deadline) {
      bad('timed out after ' + timeoutMs + 'ms waiting for: ' + label);
      return false;
    }
    await sleep(20);
  }
}

async function submitWithDialog(formSel, fillIn, label) {
  const form = nodeFor(formSel);
  fillIn();
  form._fire('submit', { preventDefault() {} });
  confirmDialog(); /* the dialog is built synchronously by the submit handler */
  await sleep(0);
  ok('UI action submitted: ' + label);
}

const UI2 = win.ML_UI;
const D2 = win.ML_DEMO;
D2.clearAll();
D2.reset();
await app.refresh();

/* supply 5 ETH through the form */
await submitWithDialog('#form-supply', () => {
  nodeFor('#supply-amount').value = '5';
  nodeFor('input[name="supply-mode"]:checked').value = 'deposit';
}, 'supply 5 ETH from the supply form');
if (await waitFor(() => D2.stats().totalLiquidity === 5n * 10n ** 18n, 'the form supply to reach the ledger')) {
  ok('ledger totalLiquidity is now ' + UI2.formatEth(D2.stats().totalLiquidity) + ' ETH');
}

/* borrow 2 ETH at 12% for 30 days with 2 ETH collateral */
await submitWithDialog('#form-borrow', () => {
  nodeFor('#borrow-principal').value = '2';
  nodeFor('#borrow-rate').value = '12.00';
  nodeFor('#borrow-duration').value = '30';
  nodeFor('#borrow-collateral').value = '2';
}, 'request 2 ETH loan from the borrow form');
if (await waitFor(() => {
  const loans = D2.getUserLoans(D2.address);
  return loans.length === 1 && loans[0].status === 2;
}, 'the borrowed loan to activate')) {
  const mine = D2.getUserLoans(D2.address);
  ok('loan #' + mine[0].id + ' is active with ' + UI2.formatEth(mine[0].principal) + ' ETH principal');
}
const loanId = D2.getUserLoans(D2.address)[0].id;

/* click Repay on that row */
const loansBody = nodeFor('#loans-body');
const rowButton = (action, id) => ({
  closest: () => ({ getAttribute: (k) => (k === 'data-action' ? action : k === 'data-loan-id' ? String(id) : null) })
});
await app.refresh();
loansBody._fire('click', { target: rowButton('repay', loanId) });
confirmDialog();
if (await waitFor(() => D2.getLoan(loanId).status === 3, 'the Repay button to settle loan #' + loanId)) {
  ok('Repay button settled loan #' + loanId + ' and returned the collateral');
}

/* create an overdue loan, then click Liquidate on it */
const doomed = D2.requestLoan(D2.address, {
  principal: (1n * 10n ** 18n).toString(), rateBps: '5000', durationDays: '5', collateral: (1n * 10n ** 18n).toString()
});
D2.advanceTime(20 * 86400);
await app.refresh();
const overdueRow = app.state().loans.filter((l) => l.id === doomed.loanId)[0];
if (!overdueRow) bad('overdue loan missing from the rendered state');
if (overdueRow && overdueRow.overdue !== true) bad('the overdue loan is not flagged as overdue in the rendered state');
loansBody._fire('click', { target: rowButton('liquidate', doomed.loanId) });
confirmDialog();
if (await waitFor(() => D2.getLoan(doomed.loanId).status === 4, 'the Liquidate button to settle loan #' + doomed.loanId)) {
  ok('Liquidate button settled loan #' + doomed.loanId + ' and recorded ' + UI2.formatEth(D2.stats().totalBadDebt) + ' ETH of bad debt');
}
if (!D2.audit().balanced) bad('ledger drifted out of balance through the UI');
else ok('ledger still balanced after the whole UI-driven cycle');

/* advance the clock from the demo banner. The ledger clock is wall time plus an
   offset, so the assertion subtracts real elapsed seconds rather than assuming
   the wall clock stands still. */
const banner = nodeFor('#mode-banner');
const wallBefore = Math.floor(Date.now() / 1000);
const before = D2.chainTime();
banner._fire('click', { target: { closest: () => ({ getAttribute: () => 'clock-day' }) } });
const advanced = await waitFor(() => {
  const wallNow = Math.floor(Date.now() / 1000);
  return (D2.chainTime() - before) - (wallNow - wallBefore) === 86400;
}, 'the banner clock control to advance the ledger by one day', 3000);
if (advanced) ok('banner clock control advanced the ledger clock by exactly one day');
/* put the ledger back on a clean footing for the admin check */
D2.reseed();

/* the admin panel is enabled for the demo owner and locked for anyone else */
const adminLock = nodeFor('#admin-lock');
if (!adminLock.textContent || /locked/i.test(adminLock.textContent)) bad('demo desk should be treated as the pool owner');
else ok('admin panel reports the demo desk as owner');

/* The whole boot + UI-driven cycle must not log a warning or an error. */
if (captured.length) {
  bad('the app logged ' + captured.length + ' warning/error line(s) during boot and the cycle:');
  captured.slice(0, 6).forEach((line) => console.log('       ' + line.slice(0, 180)));
} else {
  ok('no console warnings or errors during boot and the whole UI-driven cycle');
}

/* the declared global surface */
console.log('\n== globals ==');
ok('ML_CONFIG, ML_CONTRACT_ABI(' + win.ML_CONTRACT_ABI.length + ' entries), ML_API, ML_WALLET, ML_UI, ML_DEMO, ML_APP, ML_CONTRACT');
for (const g of ['ML_CONFIG', 'ML_CONTRACT_ABI', 'ML_API', 'ML_WALLET', 'ML_UI', 'ML_DEMO', 'ML_APP', 'ML_CONTRACT']) {
  if (!win[g]) bad('missing global ' + g);
}
for (const fn of ['escapeHtml', 'formatEth', 'shortenAddress', 'toast', 'setBusy']) {
  if (typeof win.ML_UI[fn] !== 'function') bad('ML_UI is missing the spec-required helper ' + fn);
}
ok('ML_UI exports escapeHtml, formatEth, shortenAddress, toast and setBusy as the spec requires');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
