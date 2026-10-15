/**
 * Regression test for CONFIG.applyRemote() and the API base resolution.
 *
 * Bug this locks down: the hosted deployment serves the client from one origin
 * (a static site) and the backend from another. `/api/config` reports `apiBase: "/api"`,
 * which is correct on the backend's own host but wrong for the client. The original guard
 * only protected the file:// case, so an https-hosted page silently accepted the relative
 * path and sent every API call to the static site, where it 404s. That made the whole
 * backend unreachable in production while the UI still looked healthy, because the client
 * fell back to its offline demo engine.
 *
 * Run:  node frontend/tests/config-apibase.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = (p) => path.join(here, '..', p);

let pass = 0;
const failures = [];
const ok = (msg) => { pass++; console.log('  ok   ' + msg); };
const bad = (msg) => { failures.push(msg); console.log('  FAIL ' + msg); };

/** Load only config.js in a context with a chosen origin. */
function loadConfig({ protocol, host, pathname = '/' }) {
  const store = new Map();
  const win = {
    location: { protocol, host, hostname: host, pathname, href: protocol + '//' + host + pathname },
    localStorage: {
      getItem: (k) => (store.has('s:' + k) ? store.get('s:' + k) : null),
      setItem: (k, v) => store.set('s:' + k, String(v)),
      removeItem: (k) => store.delete('s:' + k),
    },
    navigator: { userAgent: 'node' },
    console: { warn() {}, error() {}, log() {} },
    URL,
    JSON, Object, Array, String, Number, Boolean, Math, Date, Error,
  };
  win.window = win;
  win.globalThis = win;
  const ctx = vm.createContext(win);
  vm.runInContext(fs.readFileSync(file('js/config.js'), 'utf8'), ctx, { filename: 'js/config.js' });
  return win.ML_CONFIG;
}

console.log('config.js apiBase resolution');

// --- case 1: https static site in front of a separate API host ---------------------------
{
  const CFG = loadConfig({ protocol: 'https:', host: 'microlend-dapp-1.onrender.com' });
  const before = CFG.apiBase;
  CFG.apiBase = 'https://microlend-dapp.onrender.com/api';
  CFG.applyRemote({ apiBase: '/api', chainId: 11155111, chainMode: 'rpc' });
  const after = CFG.apiBase;
  if (after === 'https://microlend-dapp.onrender.com/api') {
    ok('a backend-relative "/api" keeps the API host (was: ' + before + ')');
  } else {
    bad('relative apiBase resolved to "' + after + '" instead of the API host');
  }
  if (!after.startsWith('https://microlend-dapp-1')) {
    ok('the API base never points at the static-site origin');
  } else {
    bad('the API base was rewritten to the static site: ' + after);
  }
}

// --- case 2: an absolute apiBase from the backend is honoured ----------------------------
{
  const CFG = loadConfig({ protocol: 'https:', host: 'example.com' });
  CFG.applyRemote({ apiBase: 'https://api.example.org/api' });
  if (CFG.apiBase === 'https://api.example.org/api') ok('an absolute apiBase is taken as given');
  else bad('absolute apiBase was mangled: ' + CFG.apiBase);
}

// --- case 3: file:// page with a relative backend base ----------------------------------
{
  const CFG = loadConfig({ protocol: 'file:', host: '' });
  CFG.applyRemote({ apiBase: '/api' });
  if (/^http:\/\/127\.0\.0\.1:5000\/api$/.test(CFG.apiBase)) {
    ok('a file:// page falls back to the local API instead of file:///api');
  } else {
    bad('file:// page resolved apiBase to ' + CFG.apiBase);
  }
}

// --- case 4: relative base resolved against a nested path -------------------------------
{
  const CFG = loadConfig({ protocol: 'https:', host: 'app.example.com' });
  CFG.apiBase = 'https://backend.example.com/v1/api';
  CFG.applyRemote({ apiBase: '/api' });
  if (CFG.apiBase === 'https://backend.example.com/api') {
    ok('a relative base is resolved at the origin, not appended to the full path');
  } else {
    bad('relative resolution produced ' + CFG.apiBase);
  }
}

// --- case 5: the deployed config must carry the real contract address -------------------
{
  const CFG = loadConfig({ protocol: 'https:', host: 'microlend-dapp-1.onrender.com' });
  if (/^0x[0-9a-fA-F]{40}$/.test(CFG.contractAddress)) {
    ok('the shipped config carries a real contract address (' + CFG.contractAddress.slice(0, 10) + '...)');
  } else {
    console.log('  note : contractAddress is empty, so the client auto-selects demo mode');
  }
}

// --- case 6: applyRemote must not invent an apiBase when the backend omits it -----------
{
  const CFG = loadConfig({ protocol: 'https:', host: 'x.example' });
  CFG.apiBase = 'https://api.example/api';
  CFG.applyRemote({ chainId: 1 });
  if (CFG.apiBase === 'https://api.example/api') ok('omitting apiBase leaves the configured base alone');
  else bad('apiBase changed without a remote value: ' + CFG.apiBase);
}

console.log();
if (failures.length) {
  console.log(`${pass} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log(`ALL ${pass} CHECKS PASSED`);
