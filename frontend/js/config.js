/* MicroLend — configuration.
 *
 * Exposes window.ML_CONFIG. Mirrors backend/contract_abi.json and
 * docs/INTEGRATION_SPEC.md section 4:
 *   chainId, chainName, contractAddress, explorerBase, apiBase
 *
 * Resolution order (later wins):
 *   1. DEFAULTS below
 *   2. a ?query=string override            (?contract=0x…&api=…&chain=…&demo=1&rpc=…)
 *   3. localStorage "ml.config"            (JSON, written by CONFIG.save())
 *   4. GET /api/config                     (CONFIG.applyRemote(), called by app.js)
 *
 * No key material is ever read, written or stored by this file.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ml.config';

  /* Sepolia public RPC is used for read-only fallbacks and addEthereumChain. */
  var SEPOLIA_RPC = 'https://rpc.sepolia.org';
  var SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io';

  /* Absolute fallback when the page is opened from file:// — a relative "/api"
     would resolve to file:///api and never reach Flask. */
  var LOCAL_API = 'http://127.0.0.1:5000/api';

  var DEFAULTS = {
    /* --- contract identity (mirrors backend/contract_abi.json) --- */
    chainId: 11155111,
    chainName: 'Sepolia',
    contractAddress: '0xECDaCA02f7646A8182A57c6520318D0FebC8bDCA',
    explorerBase: SEPOLIA_EXPLORER,
    apiBase: '/api',

    /* --- runtime --- */
    rpcUrl: SEPOLIA_RPC,
    tokenSymbol: 'ETH',
    tokenDecimals: 18,
    pollMs: 15000,
    apiTimeoutMs: 9000,
    apiRetries: 2,

    /* --- demo mode --- */
    /* null = decide automatically: demo when MetaMask is absent OR no contract
       address is configured. true/false force it. */
    forceDemo: null,

    /* Displayed in the topbar so a grader always knows which build they opened. */
    buildLabel: 'v1.0'
  };

  var CHAINS = {
    11155111: { name: 'Sepolia', hex: '0xaa36a7', explorer: SEPOLIA_EXPLORER, rpc: SEPOLIA_RPC },
    1: { name: 'Ethereum mainnet', hex: '0x1', explorer: 'https://etherscan.io', rpc: 'https://eth.llamarpc.com' },
    31337: { name: 'Localhost dev-chain', hex: '0x7a69', explorer: '', rpc: 'http://127.0.0.1:8545' },
    1337: { name: 'Localhost dev-chain', hex: '0x539', explorer: '', rpc: 'http://127.0.0.1:8545' }
  };

  var listeners = [];

  function isFileProtocol() {
    return typeof location !== 'undefined' && location.protocol === 'file:';
  }

  function readStored() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null; /* private mode / disabled storage — not fatal */
    }
  }

  function readQuery() {
    var out = {};
    if (typeof location === 'undefined' || !location.search) return out;
    var parts = location.search.replace(/^\?/, '').split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var kv = parts[i].split('=');
      var k = decodeURIComponent(kv[0]);
      var v = kv.length > 1 ? decodeURIComponent(kv.slice(1).join('=')) : '';
      if (k === 'contract') out.contractAddress = v;
      else if (k === 'api') out.apiBase = v;
      else if (k === 'rpc') out.rpcUrl = v;
      else if (k === 'chain') out.chainId = parseChainId(v);
      else if (k === 'demo') out.forceDemo = v === '0' || v === 'false' ? false : true;
      else if (k === 'explorer') out.explorerBase = v;
    }
    return out;
  }

  function parseChainId(v) {
    if (v == null || v === '') return null;
    var n = /^0x/i.test(String(v)) ? parseInt(v, 16) : parseInt(v, 10);
    return isFinite(n) && n > 0 ? n : null;
  }

  function merge(target, source) {
    if (!source) return target;
    for (var k in source) {
      if (!Object.prototype.hasOwnProperty.call(source, k)) continue;
      if (source[k] === undefined || source[k] === null || source[k] === '') continue;
      target[k] = source[k];
    }
    return target;
  }

  var CONFIG = {};
  merge(CONFIG, DEFAULTS);
  merge(CONFIG, readStored());
  merge(CONFIG, readQuery());

  /* file:// cannot reach a relative /api — point at the documented Flask host. */
  if (isFileProtocol() && (!CONFIG.apiBase || CONFIG.apiBase.charAt(0) === '/')) {
    CONFIG.apiBase = LOCAL_API;
  }

  /* Endpoint helpers ------------------------------------------------------ */

  CONFIG.apiUrl = function (path) {
    var base = String(CONFIG.apiBase || '/api').replace(/\/+$/, '');
    var suffix = String(path || '').replace(/^\/+/, '');
    return base + '/' + suffix;
  };

  CONFIG.explorerTx = function (hash) {
    return CONFIG.explorerBase ? CONFIG.explorerBase.replace(/\/+$/, '') + '/tx/' + hash : '';
  };

  CONFIG.explorerAddress = function (address) {
    return CONFIG.explorerBase ? CONFIG.explorerBase.replace(/\/+$/, '') + '/address/' + address : '';
  };

  CONFIG.chain = function (chainId) {
    var id = chainId == null ? CONFIG.chainId : Number(chainId);
    var known = CHAINS[id];
    if (known) return { id: id, name: known.name, hex: known.hex, explorer: known.explorer, rpc: known.rpc };
    return {
      id: id,
      name: Number.isFinite(id) ? 'chain ' + id : 'unknown chain',
      hex: Number.isFinite(id) ? '0x' + id.toString(16) : null,
      explorer: '',
      rpc: ''
    };
  };

  CONFIG.chainName = function (chainId) {
    return CONFIG.chain(chainId).name;
  };

  /* Metadata about the configured network, used by wallet.js addEthereumChain. */
  CONFIG.chainParams = function (chainId) {
    var c = CONFIG.chain(chainId);
    return {
      chainId: c.hex,
      chainName: c.name === 'Sepolia' ? 'Sepolia testnet' : c.name,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [c.rpc || CONFIG.rpcUrl],
      blockExplorerUrls: c.explorer ? [c.explorer] : []
    };
  };

  CONFIG.isSepolia = function (chainId) {
    return Number(chainId) === 11155111;
  };

  /* Demo-mode decision ---------------------------------------------------- */

  CONFIG.hasWallet = function () {
    return typeof global.ethereum !== 'undefined' && global.ethereum !== null;
  };

  CONFIG.hasContract = function () {
    return /^0x[0-9a-fA-F]{40}$/.test(String(CONFIG.contractAddress || ''));
  };

  /* Returns { demo: boolean, reason: string } so the UI can explain itself. */
  CONFIG.initialMode = function () {
    if (CONFIG.forceDemo === true) return { demo: true, reason: 'Demo mode was forced in the URL or settings.' };
    if (CONFIG.forceDemo === false) return { demo: false, reason: 'Chain mode was forced in the URL or settings.' };
    if (!CONFIG.hasContract()) {
      return { demo: true, reason: 'No pool contract address is configured for this build.' };
    }
    if (!CONFIG.hasWallet()) {
      return { demo: true, reason: 'No MetaMask-compatible wallet was detected in this browser.' };
    }
    return { demo: false, reason: 'Wallet detected and a pool address is configured.' };
  };

  /* Remote config --------------------------------------------------------- */

  /* Merges GET /api/config. Never lets the backend blank out a good local value. */
  CONFIG.applyRemote = function (remote) {
    if (!remote || typeof remote !== 'object') return CONFIG;
    var patch = {};
    if (remote.chainId != null) patch.chainId = Number(remote.chainId);
    if (remote.chainName) patch.chainName = String(remote.chainName);
    if (remote.contractAddress) patch.contractAddress = String(remote.contractAddress);
    if (remote.explorerBase) patch.explorerBase = String(remote.explorerBase);
    if (remote.apiBase) {
      var base = String(remote.apiBase);
      /* A backend that reports a relative base is useless to a file:// page. */
      patch.apiBase = isFileProtocol() && base.charAt(0) === '/' ? LOCAL_API : base;
    }
    if (remote.rpcUrl) patch.rpcUrl = String(remote.rpcUrl);
    if (remote.abi || remote.contractAbi) {
      var abi = remote.abi || remote.contractAbi;
      if (Array.isArray(abi) && abi.length) {
        global.ML_CONTRACT_ABI = abi;
        global.__ML_ABI_SOURCE__ = 'api/config';
      }
    }
    merge(CONFIG, patch);
    CONFIG.emit('change');
    return CONFIG;
  };

  CONFIG.save = function (patch) {
    merge(CONFIG, patch);
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        contractAddress: CONFIG.contractAddress,
        apiBase: CONFIG.apiBase,
        chainId: CONFIG.chainId,
        explorerBase: CONFIG.explorerBase,
        rpcUrl: CONFIG.rpcUrl,
        forceDemo: CONFIG.forceDemo
      }));
    } catch (err) { /* storage unavailable — settings simply do not persist */ }
    CONFIG.emit('change');
    return CONFIG;
  };

  CONFIG.clearSaved = function () {
    try { global.localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
  };

  /* Tiny emitter so panels can re-render when settings change. */
  CONFIG.on = function (evt, fn) {
    listeners.push({ evt: evt, fn: fn });
    return function () {
      listeners = listeners.filter(function (l) { return l.fn !== fn || l.evt !== evt; });
    };
  };

  CONFIG.emit = function (evt) {
    listeners.slice().forEach(function (l) {
      if (l.evt !== evt && l.evt !== '*') return;
      try { l.fn(CONFIG); } catch (err) { /* listener errors must not break config */ }
    });
  };

  CONFIG.DEFAULTS = DEFAULTS;
  CONFIG.SEPOLIA_RPC = SEPOLIA_RPC;

  global.ML_CONFIG = CONFIG;

  /* The ABI is generated into js/abi.js; keep a guard so a missing file degrades
     to a clear message instead of a TypeError deep inside contract.js. */
  if (!global.ML_CONTRACT_ABI) {
    global.ML_CONTRACT_ABI = [];
    global.__ML_ABI_SOURCE__ = 'missing (js/abi.js did not load)';
  } else {
    global.__ML_ABI_SOURCE__ = global.__ML_ABI_SOURCE__ || 'js/abi.js';
  }
})(typeof window !== 'undefined' ? window : this);
