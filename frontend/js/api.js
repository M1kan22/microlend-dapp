/* MicroLend — Flask backend client (docs/INTEGRATION_SPEC.md section 3).
 *
 * Every response is either {"ok": true, "data": ...} or
 * {"ok": false, "error": {"code", "message", "fields"}}. This file unwraps the
 * envelope, turns an error envelope into a typed ApiError, retries transient
 * failures with backoff, and holds the bearer session token.
 *
 * The token lives in sessionStorage (cleared when the tab closes) and never
 * contains key material — it is a backend session token issued after the user
 * signs a nonce with their own wallet.
 */
(function (global) {
  'use strict';

  var TOKEN_KEY = 'ml.token';

  var state = {
    online: null,       /* null = unknown, true/false once probed */
    lastError: null,
    latencyMs: null,
    checkedAt: null
  };

  var RETRY_STATUS = [408, 425, 429, 500, 502, 503, 504];

  /* ------------------------------------------------------------------ *
   * Token handling
   * ------------------------------------------------------------------ */

  function readToken() {
    try { return global.sessionStorage.getItem(TOKEN_KEY) || null; } catch (err) { return null; }
  }

  function setToken(token, expiresAt) {
    try {
      if (token) global.sessionStorage.setItem(TOKEN_KEY, token);
      else global.sessionStorage.removeItem(TOKEN_KEY);
      if (expiresAt) global.sessionStorage.setItem(TOKEN_KEY + '.exp', String(expiresAt));
    } catch (err) { /* private mode: the session simply does not persist across reloads */ }
  }

  function tokenExpiry() {
    try {
      var raw = global.sessionStorage.getItem(TOKEN_KEY + '.exp');
      return raw ? Number(raw) : null;
    } catch (err) { return null; }
  }

  function hasSession() {
    var token = readToken();
    if (!token) return false;
    var exp = tokenExpiry();
    if (exp && Date.now() > exp) return false;
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Errors
   * ------------------------------------------------------------------ */

  function ApiError(info) {
    var err = new Error(info.message || 'The backend reported an error.');
    err.name = 'ApiError';
    err.code = info.code || 'INTERNAL_ERROR';
    err.status = info.status || 0;
    err.fields = info.fields || null;
    err.userMessage = humanMessage(err);
    return err;
  }

  var CODE_TEXT = {
    VALIDATION_ERROR: 'The backend rejected those values.',
    AUTH_REQUIRED: 'Sign in first: the backend needs a signature from your wallet.',
    AUTH_INVALID: 'That session has expired. Sign in again.',
    NOT_FOUND: 'The backend has no record of that.',
    CONFLICT: 'The backend already has a different record for this transaction.',
    UPSTREAM_ERROR: 'The backend could not reach the chain.',
    RATE_LIMITED: 'Too many requests. Waiting a moment and retrying is safe.',
    INTERNAL_ERROR: 'The backend hit an internal error.',
    NETWORK_ERROR: 'The backend is not reachable.'
  };

  function humanMessage(err) {
    var base = CODE_TEXT[err.code];
    var detail = err.message && err.message !== err.code ? err.message : '';
    if (err.fields) {
      var names = Object.keys(err.fields);
      if (names.length) {
        var first = names[0];
        var field = err.fields[first];
        var text = Array.isArray(field) ? field[0] : field;
        if (text) return (base ? base + ' ' : '') + first + ': ' + text;
      }
    }
    if (base && detail) return base + ' ' + detail;
    return detail || base || 'The backend reported an error.';
  }

  /* ------------------------------------------------------------------ *
   * Request core
   * ------------------------------------------------------------------ */

  function timeoutSignal(ms) {
    if (typeof AbortController === 'undefined') return { signal: undefined, cancel: function () {} };
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, ms);
    return {
      signal: controller.signal,
      cancel: function () { clearTimeout(timer); }
    };
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function backoffMs(attempt, retryAfter) {
    if (retryAfter) {
      var seconds = Number(retryAfter);
      if (isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 8000);
    }
    return Math.min(400 * Math.pow(2.4, attempt), 4000) + Math.floor(Math.random() * 120);
  }

  /* opts: {method, body, auth, retries, timeoutMs, signal} */
  function request(path, opts) {
    var o = opts || {};
    var method = (o.method || 'GET').toUpperCase();
    var attempts = o.retries === undefined ? global.ML_CONFIG.apiRetries : o.retries;
    var timeout = o.timeoutMs === undefined ? global.ML_CONFIG.apiTimeoutMs : o.timeoutMs;
    var url = /^https?:/i.test(path) ? path : global.ML_CONFIG.apiUrl(path);

    var headers = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    if (o.auth) {
      var token = readToken();
      if (token) headers.Authorization = 'Bearer ' + token;
    }

    function attempt(n) {
      var guard = timeoutSignal(timeout);
      var started = Date.now();
      return fetch(url, {
        method: method,
        headers: headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: guard.signal,
        mode: 'cors',
        credentials: 'omit'
      }).then(function (response) {
        guard.cancel();
        return response.text().then(function (text) {
          var payload = null;
          if (text) {
            try { payload = JSON.parse(text); } catch (err) { payload = null; }
          }
          if (!response.ok || (payload && payload.ok === false)) {
            var envelope = payload && payload.error ? payload.error : {};
            var apiErr = ApiError({
              code: envelope.code || (response.status === 401 ? 'AUTH_REQUIRED' : 'INTERNAL_ERROR'),
              message: envelope.message || (payload ? '' : text.slice(0, 200)) ||
                ('HTTP ' + response.status + ' ' + (response.statusText || '')),
              fields: envelope.fields,
              status: response.status
            });
            var retryable = RETRY_STATUS.indexOf(response.status) !== -1;
            if (retryable && n < attempts) {
              return delay(backoffMs(n, response.headers.get('Retry-After'))).then(function () { return attempt(n + 1); });
            }
            if (response.status === 401) setToken(null);
            state.online = true;
            throw apiErr;
          }
          state.online = true;
          state.lastError = null;
          state.latencyMs = Date.now() - started;
          state.checkedAt = Date.now();
          global.ML_CONFIG.emit('api');
          return payload ? payload.data : null;
        });
      }, function (err) {
        guard.cancel();
        var aborted = err && (err.name === 'AbortError');
        if (n < attempts) {
          return delay(backoffMs(n)).then(function () { return attempt(n + 1); });
        }
        state.online = false;
        state.lastError = aborted
          ? 'The backend did not answer within ' + Math.round(timeout / 1000) + ' seconds.'
          : 'The backend at ' + url + ' is not reachable from this page.';
        global.ML_CONFIG.emit('api');
        throw ApiError({
          code: 'NETWORK_ERROR',
          message: state.lastError,
          status: 0
        });
      });
    }

    return attempt(0);
  }

  function get(path, opts) {
    var o = opts || {};
    o.method = 'GET';
    return request(path, o);
  }

  function post(path, body, opts) {
    var o = opts || {};
    o.method = 'POST';
    o.body = body === undefined ? {} : body;
    return request(path, o);
  }

  /* ------------------------------------------------------------------ *
   * Endpoints (section 3)
   * ------------------------------------------------------------------ */

  function query(params) {
    var parts = [];
    Object.keys(params || {}).forEach(function (k) {
      var v = params[k];
      if (v === undefined || v === null || v === '') return;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }

  var API = {
    ApiError: ApiError,
    humanMessage: humanMessage,
    query: query,
    request: request,
    get: get,
    post: post,

    base: function () { return global.ML_CONFIG.apiBase; },
    status: function () { return { online: state.online, lastError: state.lastError, latencyMs: state.latencyMs, checkedAt: state.checkedAt }; },

    /* --- session --- */
    token: readToken,
    hasSession: hasSession,
    clearSession: function () { setToken(null); },
    nonce: function (address) { return post('/auth/nonce', { address: address }, { retries: 0 }); },
    verify: function (address, signature) {
      return post('/auth/verify', { address: address, signature: signature }, { retries: 0 });
    },
    session: function () { return get('/auth/session', { auth: true, retries: 0 }); },
    logout: function () {
      return post('/auth/logout', {}, { auth: true, retries: 0 }).then(function (data) {
        setToken(null);
        return data;
      }, function (err) {
        setToken(null);
        throw err;
      });
    },

    /* Full login handshake: nonce -> personal_sign -> verify -> token. */
    login: function (address, signFn) {
      return API.nonce(address).then(function (data) {
        var message = data && (data.message || data.nonce);
        if (!message) throw new Error('The backend did not return a message to sign.');
        return signFn(message, address).then(function (signature) {
          return API.verify(address, signature);
        });
      }).then(function (data) {
        if (data && data.token) setToken(data.token, data.expiresAt ? new Date(data.expiresAt).getTime() : null);
        return data;
      });
    },

    /* --- reads --- */
    health: function () { return get('/health', { retries: 0 }); },
    config: function () { return get('/config', { retries: 0 }); },
    pool: function () { return get('/pool'); },
    loans: function (params) { return get('/loans' + query(params)); },
    loan: function (id) { return get('/loans/' + encodeURIComponent(id)); },
    loanHistory: function (id) { return get('/loans/' + encodeURIComponent(id) + '/history'); },
    preview: function (payload) { return post('/loans/preview', payload, { retries: 0 }); },
    transactions: function (params) { return get('/transactions' + query(params)); },
    position: function (address) { return get('/positions/' + encodeURIComponent(address)); },
    simulate: function (action, params) { return post('/simulate', { action: action, params: params || {} }, { retries: 0 }); },

    /* --- writes (all require a bearer token) --- */
    createLoan: function (payload) { return post('/loans', payload, { auth: true, retries: 0 }); },
    fundLoan: function (id, payload) { return post('/loans/' + encodeURIComponent(id) + '/fund', payload, { auth: true, retries: 0 }); },
    repayLoan: function (id, payload) { return post('/loans/' + encodeURIComponent(id) + '/repay', payload, { auth: true, retries: 0 }); },
    liquidateLoan: function (id, payload) { return post('/loans/' + encodeURIComponent(id) + '/liquidate', payload || {}, { auth: true, retries: 0 }); },
    syncTransaction: function (txHash) { return post('/transactions/sync', { txHash: txHash }, { auth: true, retries: 0 }); },

    /* Probe used at boot: decides whether history comes from the backend. */
    probe: function () {
      return API.health().then(function () {
        state.online = true;
        return true;
      }, function () {
        state.online = false;
        return false;
      });
    }
  };

  global.ML_API = API;
})(typeof window !== 'undefined' ? window : this);
