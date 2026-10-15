/* MicroLend — wallet access.
 *
 * All contact with the user's wallet goes through window.ethereum (MetaMask and
 * compatible providers). This file:
 *   - reports MetaMask's absence honestly instead of failing silently,
 *   - requests accounts only when the user asks (eth_requestAccounts),
 *   - switches/chains via wallet_switchEthereumChain and falls back to
 *     wallet_addEthereumChain when the network is unknown (error 4902),
 *   - re-reads state on accountsChanged / chainChanged / disconnect,
 *   - signs the backend's login nonce with personal_sign.
 *
 * NO PRIVATE KEY, SEED PHRASE OR MNEMONIC IS EVER READ, REQUESTED OR STORED.
 * The only wallet secret involved stays inside the extension: MetaMask returns a
 * signature, which this file keeps in memory for the length of one request and
 * hands to the backend for verification.
 */
(function (global) {
  'use strict';

  var listeners = [];

  var state = {
    address: null,
    chainId: null,
    balanceWei: 0n,
    connecting: false,
    lastError: null,
    source: 'none' /* 'metamask' | 'injected' | 'none' */
  };

  /* ------------------------------------------------------------------ *
   * Provider discovery
   * ------------------------------------------------------------------ */

  function injected() {
    var eth = global.ethereum;
    if (!eth) return null;
    /* Multiple wallets inject into window.ethereum; prefer MetaMask when the
       provider announces itself through providers[]. */
    if (Array.isArray(eth.providers) && eth.providers.length) {
      for (var i = 0; i < eth.providers.length; i++) {
        if (eth.providers[i] && eth.providers[i].isMetaMask) return eth.providers[i];
      }
      return eth.providers[0];
    }
    return eth;
  }

  function available() {
    return !!injected();
  }

  function describeProvider(provider) {
    if (!provider) return 'none';
    if (provider.isMetaMask) return 'metamask';
    if (provider.isRabby) return 'rabby';
    if (provider.isCoinbaseWallet) return 'coinbase';
    return 'injected';
  }

  /* ------------------------------------------------------------------ *
   * Events
   * ------------------------------------------------------------------ */

  function on(evt, fn) {
    listeners.push({ evt: evt, fn: fn });
    return function off() {
      listeners = listeners.filter(function (l) { return !(l.evt === evt && l.fn === fn); });
    };
  }

  function emit(evt, payload) {
    listeners.slice().forEach(function (l) {
      if (l.evt !== evt && l.evt !== '*') return;
      try { l.fn(payload, snapshot()); } catch (err) { /* a bad listener must not break the wallet */ }
    });
  }

  function snapshot() {
    return {
      address: state.address,
      chainId: state.chainId,
      balanceWei: state.balanceWei,
      connected: !!state.address,
      source: state.source,
      lastError: state.lastError
    };
  }

  /* ------------------------------------------------------------------ *
   * Errors
   * ------------------------------------------------------------------ */

  function providerError(err, fallback) {
    var code = err && (err.code !== undefined ? err.code : (err.data && err.data.originalError && err.data.originalError.code));
    var info = {
      code: code === undefined ? null : code,
      rejected: code === 4001 || code === 'ACTION_REJECTED',
      pending: code === -32002,
      unknownChain: code === 4902
    };
    if (info.rejected) {
      info.message = 'The request was rejected in the wallet. Nothing was sent.';
    } else if (info.pending) {
      info.message = 'The wallet already has a pending request for this site. Open the extension and finish or dismiss it.';
    } else if (info.unknownChain) {
      info.message = 'The wallet does not know this network yet. It can be added from here.';
    } else {
      info.message = (err && (err.message || err.reason)) || fallback || 'The wallet reported an error.';
    }
    return info;
  }

  function fail(err, fallback) {
    var info = providerError(err, fallback);
    state.lastError = info;
    emit('error', info);
    var out = new Error(info.message);
    out.info = info;
    throw out;
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

  function rpc(method, params) {
    var provider = injected();
    if (!provider) return Promise.reject(new Error('No wallet is available.'));
    return provider.request({ method: method, params: params || [] });
  }

  function accounts() {
    return rpc('eth_accounts').then(function (list) {
      return Array.isArray(list) && list.length ? list[0] : null;
    }, function () { return null; });
  }

  function chainId() {
    return rpc('eth_chainId').then(function (hex) {
      return parseInt(hex, 16);
    }, function () { return null; });
  }

  function balanceOf(address) {
    if (!address) return Promise.resolve(0n);
    return rpc('eth_getBalance', [address, 'latest']).then(function (hex) {
      return hex ? BigInt(hex) : 0n;
    }, function () { return 0n; });
  }

  /* Silent refresh — no prompt, safe to call on every poll. */
  function refresh() {
    var provider = injected();
    if (!provider) {
      state.source = 'none';
      state.address = null;
      state.chainId = null;
      state.balanceWei = 0n;
      emit('change', null);
      return Promise.resolve(snapshot());
    }
    state.source = describeProvider(provider);
    return Promise.all([accounts(), chainId()]).then(function (res) {
      var previous = state.address;
      state.address = res[0];
      state.chainId = res[1];
      return balanceOf(state.address).then(function (bal) {
        state.balanceWei = bal;
        if (previous !== state.address) emit('accounts', state.address);
        emit('change', null);
        return snapshot();
      });
    });
  }

  /* ------------------------------------------------------------------ *
   * Writes
   * ------------------------------------------------------------------ */

  function connect() {
    var provider = injected();
    if (!provider) {
      state.lastError = {
        code: null,
        rejected: false,
        message: 'No Ethereum wallet was detected in this browser. Install MetaMask, or keep using demo mode to exercise the protocol offline.'
      };
      emit('error', state.lastError);
      return Promise.reject(new Error(state.lastError.message));
    }
    state.connecting = true;
    emit('connecting', true);
    state.source = describeProvider(provider);
    return provider.request({ method: 'eth_requestAccounts' }).then(function (list) {
      state.connecting = false;
      emit('connecting', false);
      state.address = Array.isArray(list) && list.length ? list[0] : null;
      return refresh();
    }, function (err) {
      state.connecting = false;
      emit('connecting', false);
      state.lastError = providerError(err, 'The wallet refused the connection request.');
      emit('error', state.lastError);
      throw new Error(state.lastError.message);
    });
  }

  /* Forgets the local session only: a dApp cannot, and must not pretend to,
     disconnect a wallet at the extension level. */
  function forget() {
    state.address = null;
    state.balanceWei = 0n;
    state.lastError = null;
    emit('accounts', null);
    emit('change', null);
    return Promise.resolve(snapshot());
  }

  function switchChain(targetChainId, opts) {
    var o = opts || {};
    var provider = injected();
    if (!provider) return Promise.reject(new Error('No wallet is available to switch networks.'));
    var hex = '0x' + Number(targetChainId).toString(16);
    return provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] }).then(function () {
      return refresh();
    }, function (err) {
      var info = providerError(err);
      if (!info.unknownChain || o.addIfMissing === false) throw new Error(info.message);
      var params = global.ML_CONFIG.chainParams(targetChainId);
      return provider.request({ method: 'wallet_addEthereumChain', params: [params] }).then(function () {
        return refresh();
      }, function (addErr) {
        throw new Error(providerError(addErr, 'The network could not be added to the wallet.').message);
      });
    });
  }

  /* personal_sign over the backend's login nonce. Used once per session. */
  function signMessage(message, address) {
    var provider = injected();
    var from = address || state.address;
    if (!provider || !from) return Promise.reject(new Error('Connect a wallet before signing in.'));
    return provider.request({ method: 'personal_sign', params: [message, from] }).then(function (signature) {
      return signature;
    }, function (err) {
      throw new Error(providerError(err, 'The signature request was rejected.').message);
    });
  }

  /* ------------------------------------------------------------------ *
   * Provider binding + wallet event subscriptions
   * ------------------------------------------------------------------ */

  var bound = null;

  function listen() {
    var provider = injected();
    if (!provider || !provider.on || bound === provider) return;
    bound = provider;
    provider.on('accountsChanged', function (list) {
      state.address = Array.isArray(list) && list.length ? list[0] : null;
      balanceOf(state.address).then(function (bal) {
        state.balanceWei = bal;
        emit('accounts', state.address);
        emit('change', null);
      });
    });
    provider.on('chainChanged', function () {
      refresh().then(function () { emit('chain', state.chainId); });
    });
    if (provider.on) {
      provider.on('disconnect', function () {
        state.address = null;
        state.balanceWei = 0n;
        emit('accounts', null);
        emit('change', null);
      });
    }
  }

  function init() {
    if (!available()) {
      state.source = 'none';
      return Promise.resolve(snapshot());
    }
    listen();
    return refresh();
  }

  global.ML_WALLET = {
    available: available,
    providerKind: function () { return describeProvider(injected()); },
    injected: injected,
    init: init,
    refresh: refresh,
    connect: connect,
    forget: forget,
    switchChain: switchChain,
    signMessage: signMessage,
    on: on,
    addresses: function () { return { address: state.address, chainId: state.chainId }; },
    address: function () { return state.address; },
    chainId: function () { return state.chainId; },
    balanceWei: function () { return state.balanceWei; },
    connected: function () { return !!state.address; },
    connecting: function () { return state.connecting; },
    lastError: function () { return state.lastError; },
    state: snapshot
  };
})(typeof window !== 'undefined' ? window : this);
