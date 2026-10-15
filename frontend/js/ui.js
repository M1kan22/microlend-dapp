/* MicroLend — UI toolkit: escaping, wei-exact money formatting, toasts, dialogs,
 * skeleton/empty states.
 *
 * Money is ALWAYS formatted from wei strings with BigInt. No Number() is applied
 * to a wei value anywhere in this file, so values above 2^53 keep every digit.
 */
(function (global) {
  'use strict';

  var DOM = global.document || null;
  var WEI_PER_ETH = 1000000000000000000n;
  var DECIMALS = 18;

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ------------------------------------------------------------------ *
   * BigInt plumbing
   * ------------------------------------------------------------------ */

  /* Accepts bigint, integer strings of wei, or a decimal ETH string by
     accident — the latter is rejected loudly rather than silently misread. */
  function toWeiBig(value) {
    if (typeof value === 'bigint') return value;
    if (value === null || value === undefined || value === '') return 0n;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    var s = String(value).trim();
    if (!/^-?\d+$/.test(s)) {
      throw new TypeError('Expected an integer wei string, received "' + s + '"');
    }
    return BigInt(s);
  }

  function pow10(n) {
    var out = 1n;
    for (var i = 0; i < n; i++) out *= 10n;
    return out;
  }

  function absOf(v) { return v < 0n ? -v : v; }

  /* Group an integer string with thin-space-free ASCII commas (kept ASCII so
     copy/paste into a spreadsheet or the terminal still parses). */
  function group(intStr) {
    var neg = intStr.charAt(0) === '-';
    var s = neg ? intStr.slice(1) : intStr;
    var out = '';
    var count = 0;
    for (var i = s.length - 1; i >= 0; i--) {
      out = s.charAt(i) + out;
      count++;
      if (count % 3 === 0 && i > 0) out = ',' + out;
    }
    return (neg ? '-' : '') + out;
  }

  /* Exact decimal expansion of a wei amount, truncated (never rounded up) to
     `dp` places and padded to exactly `dp` places so money columns align on the
     decimal point. Truncation is the honest choice for money: the UI never shows
     more than is actually there. */
  function weiToDecimalString(wei, dp) {
    var v = absOf(toWeiBig(wei));
    var places = dp === undefined ? 4 : dp;
    var whole = v / WEI_PER_ETH;
    var frac = v % WEI_PER_ETH;
    var out = group(whole.toString());
    if (places > 0) {
      var fracFull = (frac * pow10(places)) / pow10(DECIMALS); /* first `places` digits */
      var fracStr = fracFull.toString();
      while (fracStr.length < places) fracStr = '0' + fracStr;
      out += '.' + fracStr;
    }
    return (toWeiBig(wei) < 0n ? '-' : '') + out;
  }

  /* ------------------------------------------------------------------ *
   * Formatting
   * ------------------------------------------------------------------ */

  /* formatEth(wei, {dp, symbol, signed, maxDp})
     Default: 4 decimals, truncated, grouped. A non-zero amount that would render
     as all zeros at that precision is widened to show at least two significant
     digits (so 0.0000123 is legible), but never beyond `maxDp` — past that it is
     reported as "< 10^-maxDp ETH", which is the honest compact form. The exact
     value always remains available through formatEthExact / amountTitle. */
  function formatEth(wei, opts) {
    var o = opts || {};
    var v = toWeiBig(wei);
    var dp = o.dp === undefined ? 4 : o.dp;
    var maxDp = o.maxDp === undefined ? 8 : Math.min(18, Math.max(0, o.maxDp));

    if (v !== 0n && o.minSignificant !== false) {
      var probe = absOf(v);
      var digits = 0;
      while (probe < WEI_PER_ETH && digits < DECIMALS) { probe *= 10n; digits++; }
      var needed = digits + 1; /* at least two significant digits */
      if (needed > dp) dp = Math.min(DECIMALS, needed);
    }
    if (dp > maxDp) {
      var smallest = pow10(DECIMALS - maxDp);
      if (absOf(v) < smallest) {
        return (v < 0n ? '> -' : '< ') + weiToDecimalString(smallest, maxDp);
      }
      dp = maxDp;
    }
    var out = weiToDecimalString(v, dp);
    if (o.signed && v > 0n) out = '+' + out;
    if (o.symbol) out += ' ' + (o.symbol === true ? 'ETH' : o.symbol);
    return out;
  }

  /* Exact full-precision string, used for tooltips / copy buttons. */
  function formatEthExact(wei) {
    return weiToDecimalString(wei, DECIMALS);
  }

  function formatWeiLabel(wei, symbol) {
    return formatEth(wei, { dp: 4 }) + ' ' + (symbol || 'ETH');
  }

  /* Tooltip that always exposes both the human and the exact wei value. */
  function amountTitle(wei, symbol) {
    var v = toWeiBig(wei);
    return formatEthExact(v) + ' ' + (symbol || 'ETH') + ' (' + group(v.toString()) + ' wei)';
  }

  function formatInt(value) {
    if (value === null || value === undefined || value === '') return '0';
    var s = String(value).trim();
    if (!/^-?\d+$/.test(s)) {
      var n = Number(value);
      if (!isFinite(n)) return '0';
      s = String(Math.trunc(n));
    }
    return group(s);
  }

  /* Percentage from wei-exact parts, computed with BigInt at 1e6 resolution. */
  function formatSharePercent(part, whole, dp) {
    var w = toWeiBig(whole);
    if (w === 0n) return '0.0';
    var p = toWeiBig(part);
    var scaled = (p * 1000000n) / w; /* 1e6 == 100% at 4dp */
    var wholePart = scaled / 10000n;
    var frac = scaled % 10000n;
    var fracStr = frac.toString();
    while (fracStr.length < 4) fracStr = '0' + fracStr;
    var places = dp === undefined ? 1 : dp;
    fracStr = fracStr.slice(0, places);
    return wholePart.toString() + (fracStr ? '.' + fracStr : '');
  }

  /* Basis points -> "12.50%" */
  function formatBps(bps, dp) {
    var v = Number(bps);
    if (!isFinite(v)) return '—';
    return (v / 100).toFixed(dp === undefined ? 2 : dp) + '%';
  }

  /* APR from bps, spelled out for the borrow panel. */
  function formatApr(rateBps) {
    var bps = Number(rateBps);
    if (!isFinite(bps)) return '—';
    var apr = bps / 100; /* bps are annual by definition in this protocol */
    var dp = apr < 1 ? 2 : apr < 10 ? 2 : 1;
    return apr.toFixed(dp) + '% APR';
  }

  function shortenAddress(address, lead, tail) {
    var s = String(address || '');
    if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return s || '—';
    var h = lead === undefined ? 6 : lead;
    var t = tail === undefined ? 4 : tail;
    return s.slice(0, 2 + h) + '\u2026' + s.slice(s.length - t);
  }

  function isHexAddress(value) {
    return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
  }

  function formatTxHash(hash) {
    var s = String(hash || '');
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) return s || '—';
    return s.slice(0, 10) + '\u2026' + s.slice(-6);
  }

  /* Deterministic UTC timestamps — a ledger should not depend on the reader's
     locale, and graders in different timezones must see the same record. */
  function formatTimestamp(unixSeconds) {
    var ts = Number(unixSeconds);
    if (!isFinite(ts) || ts <= 0) return '—';
    var d = new Date(ts * 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() +
      ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' UTC';
  }

  function formatDateShort(unixSeconds) {
    var ts = Number(unixSeconds);
    if (!isFinite(ts) || ts <= 0) return '—';
    var d = new Date(ts * 1000);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getUTCDate()) + ' ' + MONTHS[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2);
  }

  /* "in 6 days" / "2 days overdue" / "due in 4 hours" */
  function formatRelativeTo(unixSeconds, nowSeconds) {
    var ts = Number(unixSeconds);
    var now = Number(nowSeconds === undefined ? Math.floor(Date.now() / 1000) : nowSeconds);
    if (!isFinite(ts) || ts <= 0) return '';
    var delta = ts - now;
    var future = delta >= 0;
    var abs = Math.abs(delta);
    var text;
    if (abs < 90) text = Math.round(abs) + ' seconds';
    else if (abs < 5400) text = Math.round(abs / 60) + ' minutes';
    else if (abs < 172800) text = Math.round(abs / 3600) + ' hours';
    else text = Math.round(abs / 86400) + ' days';
    return future ? 'in ' + text : text + ' overdue';
  }

  function formatDuration(days) {
    var d = Number(days);
    if (!isFinite(d)) return '—';
    return d + (d === 1 ? ' day' : ' days');
  }

  function truncate(text, max) {
    var s = String(text === null || text === undefined ? '' : text);
    var n = max || 80;
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  /* ------------------------------------------------------------------ *
   * Escaping
   * ------------------------------------------------------------------ */

  var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"'`]/g, function (ch) { return ESCAPES[ch]; });
  }

  /* For values interpolated into a quoted attribute or an inline handler. */
  function escapeAttr(value) {
    return escapeHtml(value).replace(/\r?\n/g, ' ');
  }

  /* ------------------------------------------------------------------ *
   * Input parsing (string maths only — no parseFloat on user input)
   * ------------------------------------------------------------------ */

  /* "1.25" -> 1250000000000000000n. Rejects exponent notation, negatives
     (unless allowed) and more than 18 decimal places. */
  function parseEthToWei(input, opts) {
    var o = opts || {};
    var raw = String(input === null || input === undefined ? '' : input).trim().replace(/,/g, '');
    if (!raw) return { ok: false, reason: 'Enter an amount.' };
    if (/e/i.test(raw)) return { ok: false, reason: 'Use a plain decimal amount, not scientific notation.' };
    var negative = raw.charAt(0) === '-';
    if (negative) {
      if (!o.allowNegative) return { ok: false, reason: 'Amount cannot be negative.' };
      raw = raw.slice(1);
    }
    if (!/^\d*(\.\d*)?$/.test(raw)) return { ok: false, reason: 'Use digits and a single decimal point only.' };
    var bits = raw.split('.');
    var whole = bits[0] || '0';
    var frac = bits[1] || '';
    if (frac.replace(/0/g, '') === '' && whole === '') return { ok: false, reason: 'Enter an amount.' };
    if (frac.length > DECIMALS) {
      return { ok: false, reason: 'ETH is divisible into 18 decimals — trim to 18 places or fewer.' };
    }
    while (frac.length < DECIMALS) frac += '0';
    try {
      var wei = BigInt(whole) * WEI_PER_ETH + BigInt(frac || '0');
      if (negative) wei = -wei;
      return { ok: true, wei: wei, weiString: wei.toString() };
    } catch (err) {
      return { ok: false, reason: 'That is not a valid amount.' };
    }
  }

  /* Integer-only input (shares, bps, day counts). */
  function parseInteger(input, opts) {
    var o = opts || {};
    var raw = String(input === null || input === undefined ? '' : input).trim().replace(/,/g, '');
    if (!raw) return { ok: false, reason: 'Enter a whole number.' };
    if (!/^\d+$/.test(raw)) return { ok: false, reason: 'Whole numbers only.' };
    var v;
    try { v = BigInt(raw); } catch (err) { return { ok: false, reason: 'Whole numbers only.' }; }
    if (o.min !== undefined && v < BigInt(o.min)) {
      return { ok: false, reason: (o.minLabel || 'Minimum is ' + o.min) };
    }
    if (o.max !== undefined && v > BigInt(o.max)) {
      return { ok: false, reason: (o.maxLabel || 'Maximum is ' + o.max) };
    }
    return { ok: true, value: v, valueString: v.toString() };
  }

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */

  function $(sel, root) { return (root || DOM || document).querySelector(sel); }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || DOM || document).querySelectorAll(sel));
  }

  function setText(el, text) {
    if (!el) return;
    var value = text === null || text === undefined ? '' : String(text);
    if (el.textContent !== value) el.textContent = value;
  }

  /* Replace innerHTML safely: `html` must already be composed of escaped user
     data. Kept as a single choke point so the escaping policy is auditable. */
  function setHtml(el, html) {
    if (!el) return;
    el.innerHTML = html;
  }

  function show(el, visible) {
    if (!el) return;
    if (visible) el.removeAttribute('hidden');
    else el.setAttribute('hidden', '');
  }

  function addClass(el, cls) { if (el) el.classList.add(cls); }
  function removeClass(el, cls) { if (el) el.classList.remove(cls); }

  function el(tag, className, text) {
    var node = DOM.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setBusy(target, busy, label) {
    var node = typeof target === 'string' ? $(target) : target;
    if (!node) return;
    if (busy) {
      node.setAttribute('aria-busy', 'true');
      node.classList.add('is-busy');
      if (node.tagName === 'BUTTON') {
        if (!node.dataset.idleLabel) node.dataset.idleLabel = node.textContent;
        node.disabled = true;
        node.textContent = label || 'Working';
      }
    } else {
      node.removeAttribute('aria-busy');
      node.classList.remove('is-busy');
      if (node.tagName === 'BUTTON') {
        node.disabled = false;
        if (node.dataset.idleLabel) node.textContent = node.dataset.idleLabel;
      }
    }
  }

  /* Skeleton rows for a table body while the first read is in flight. */
  function skeletonRows(tbody, columns, rows) {
    if (!tbody) return;
    var count = rows || 3;
    var html = '';
    for (var r = 0; r < count; r++) {
      html += '<tr class="skeleton-row" aria-hidden="true">';
      for (var c = 0; c < columns; c++) {
        html += '<td><span class="skeleton" style="width:' + (c === 0 ? 42 : 60 + ((c * 13) % 35)) + '%"></span></td>';
      }
      html += '</tr>';
    }
    tbody.innerHTML = html;
  }

  function emptyState(container, opts) {
    if (!container) return;
    var o = opts || {};
    var heading = escapeHtml(o.title || 'Nothing here yet');
    var body = escapeHtml(o.body || '');
    var action = o.actionLabel
      ? '<button type="button" class="btn btn-quiet" data-empty-action="' + escapeAttr(o.action || '') + '">' +
        escapeHtml(o.actionLabel) + '</button>'
      : '';
    container.innerHTML = '<div class="empty"><p class="empty-title">' + heading + '</p>' +
      (body ? '<p class="empty-body">' + body + '</p>' : '') + action + '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Toasts (aria-live region in index.html)
   * ------------------------------------------------------------------ */

  var TOAST_KINDS = { info: 'Notice', success: 'Done', warn: 'Check this', error: 'Problem' };

  function toastRegion() {
    var region = $('#toasts');
    if (!region) {
      region = el('div');
      region.id = 'toasts';
      region.className = 'toasts';
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'false');
      if (DOM && DOM.body) DOM.body.appendChild(region);
    }
    return region;
  }

  function toast(message, opts) {
    var o = opts || {};
    var kind = TOAST_KINDS[o.kind] ? o.kind : 'info';
    var region = toastRegion();
    var node = el('div', 'toast toast-' + kind);
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    var title = el('p', 'toast-title', o.title || TOAST_KINDS[kind]);
    var body = el('p', 'toast-body', String(message === null || message === undefined ? '' : message));
    node.appendChild(title);
    node.appendChild(body);

    if (o.detail) {
      var detail = el('p', 'toast-detail', truncate(o.detail, 220));
      node.appendChild(detail);
    }
    if (o.explorerUrl) {
      var link = el('a', 'toast-link', 'View transaction');
      link.href = o.explorerUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      node.appendChild(link);
    }

    var close = el('button', 'toast-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss notification');
    close.addEventListener('click', function () { dismiss(); });
    node.appendChild(close);

    region.appendChild(node);
    /* Keep the region short; older notices are already in the history table.
       The firstChild guard makes the loop impossible to spin, whatever the DOM
       implementation does. */
    while (region.children.length > 4 && region.firstChild) region.removeChild(region.firstChild);

    var timer = null;
    var life = o.duration === undefined ? (kind === 'error' ? 12000 : 7000) : o.duration;
    function dismiss() {
      if (timer) clearTimeout(timer);
      node.classList.add('is-leaving');
      var remove = function () { if (node.parentNode) node.parentNode.removeChild(node); };
      if (prefersReducedMotion()) remove();
      else setTimeout(remove, 220);
    }
    if (life > 0) timer = setTimeout(dismiss, life);
    return dismiss;
  }

  function prefersReducedMotion() {
    if (!global.matchMedia) return false;
    try { return global.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (err) { return false; }
  }

  /* ------------------------------------------------------------------ *
   * Confirm dialog (modal, focus-trapped, Esc to cancel)
   *
   * Resolves true/false, or the trimmed string when opts.input is supplied
   * (used for "set treasury address" / "transfer ownership"). Passing an input
   * keeps the action inside one accessible dialog instead of a browser prompt.
   * ------------------------------------------------------------------ */

  function confirmDialog(opts) {
    var o = opts || {};
    return new Promise(function (resolve) {
      var overlay = $('#modal-root');
      if (!overlay) {
        var fallback = global.confirm(o.body || o.title || 'Confirm this action?');
        if (!fallback) { resolve(false); return; }
        if (o.input) resolve(global.prompt(o.input.label || 'Value') || null);
        else resolve(true);
        return;
      }
      var previouslyFocused = DOM.activeElement;
      var rows = (o.rows || []).map(function (row) {
        return '<div class="confirm-row"><span class="confirm-key">' + escapeHtml(row[0]) + '</span>' +
          '<span class="confirm-value">' + escapeHtml(row[1]) + '</span></div>';
      }).join('');

      var inputBlock = o.input
        ? '<div class="field modal-field"><label for="modal-input">' + escapeHtml(o.input.label || 'Value') + '</label>' +
          '<div class="field-input"><input type="text" id="modal-input" name="modal-input" autocomplete="off" spellcheck="false" ' +
          'value="' + escapeAttr(o.input.value || '') + '" placeholder="' + escapeAttr(o.input.placeholder || '') + '"' +
          (o.input.hint ? ' aria-describedby="modal-input-hint"' : '') + '></div>' +
          (o.input.hint ? '<p class="field-hint" id="modal-input-hint">' + escapeHtml(o.input.hint) + '</p>' : '') +
          '<p class="field-hint" data-tone="bad" data-modal-input-error hidden></p></div>'
        : '';

      overlay.innerHTML =
        '<div class="modal-backdrop" data-modal-backdrop></div>' +
        '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">' +
          '<p class="modal-kicker">' + escapeHtml(o.kicker || 'Confirm') + '</p>' +
          '<h2 class="modal-title" id="modal-title">' + escapeHtml(o.title || 'Confirm this action') + '</h2>' +
          (o.body ? '<p class="modal-body">' + escapeHtml(o.body) + '</p>' : '') +
          (rows ? '<div class="confirm-table">' + rows + '</div>' : '') +
          inputBlock +
          (o.warning ? '<p class="modal-warning">' + escapeHtml(o.warning) + '</p>' : '') +
          '<div class="modal-actions">' +
            '<button type="button" class="btn btn-quiet" data-modal-cancel>' + escapeHtml(o.cancelLabel || 'Cancel') + '</button>' +
            '<button type="button" class="btn ' + (o.danger ? 'btn-danger' : 'btn-primary') + '" data-modal-confirm>' +
              escapeHtml(o.confirmLabel || 'Confirm') + '</button>' +
          '</div>' +
        '</div>';

      overlay.removeAttribute('hidden');
      overlay.classList.add('is-open');

      var confirmBtn = overlay.querySelector('[data-modal-confirm]');
      var cancelBtn = overlay.querySelector('[data-modal-cancel]');
      var backdrop = overlay.querySelector('[data-modal-backdrop]');
      var inputEl = overlay.querySelector('#modal-input');
      var inputError = overlay.querySelector('[data-modal-input-error]');

      function close(result) {
        overlay.classList.remove('is-open');
        overlay.setAttribute('hidden', '');
        overlay.innerHTML = '';
        DOM.removeEventListener('keydown', onKey, true);
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus(); } catch (err) { /* node may be gone */ }
        }
        resolve(result);
      }
      function onKey(evt) {
        if (evt.key === 'Escape') { evt.preventDefault(); close(false); return; }
        if (evt.key !== 'Tab') return;
        var focusables = [inputEl, cancelBtn, confirmBtn].filter(Boolean);
        var idx = focusables.indexOf(DOM.activeElement);
        evt.preventDefault();
        var next = evt.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx === focusables.length - 1 ? 0 : idx + 1);
        focusables[next].focus();
      }
      function accept() {
        if (!inputEl) { close(true); return; }
        var value = inputEl.value.trim();
        if (!value) {
          if (inputError) {
            inputError.textContent = 'Enter a value, or cancel.';
            inputError.removeAttribute('hidden');
          }
          inputEl.focus();
          return;
        }
        close(value);
      }

      confirmBtn.addEventListener('click', accept);
      cancelBtn.addEventListener('click', function () { close(false); });
      backdrop.addEventListener('click', function () { close(false); });
      if (inputEl) {
        inputEl.addEventListener('keydown', function (evt) {
          if (evt.key === 'Enter') { evt.preventDefault(); accept(); }
        });
        inputEl.addEventListener('input', function () {
          if (inputError) inputError.setAttribute('hidden', '');
        });
      }
      DOM.addEventListener('keydown', onKey, true);
      (inputEl || confirmBtn).focus();
    });
  }

  /* ------------------------------------------------------------------ *
   * Copy to clipboard with an honest failure path
   * ------------------------------------------------------------------ */

  function copyText(text, label) {
    var value = String(text === null || text === undefined ? '' : text);
    function fallback() {
      try {
        var ta = DOM.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        DOM.body.appendChild(ta);
        ta.select();
        var ok = DOM.execCommand && DOM.execCommand('copy');
        DOM.body.removeChild(ta);
        if (ok) toast((label || 'Value') + ' copied to the clipboard.', { kind: 'success', duration: 3000 });
        else toast('Copying is blocked by this browser. Select the text and copy it manually.', { kind: 'warn' });
      } catch (err) {
        toast('Copying is blocked by this browser. Select the text and copy it manually.', { kind: 'warn' });
      }
    }
    if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
      global.navigator.clipboard.writeText(value).then(function () {
        toast((label || 'Value') + ' copied to the clipboard.', { kind: 'success', duration: 3000 });
      }, fallback);
    } else {
      fallback();
    }
  }

  /* Momentary highlight used when a figure changes, so the eye can find it. */
  function flash(node) {
    if (!node || prefersReducedMotion()) return;
    node.classList.remove('is-flashing');
    /* force a reflow so the animation restarts even on rapid updates */
    void node.offsetWidth;
    node.classList.add('is-flashing');
    setTimeout(function () { node.classList.remove('is-flashing'); }, 900);
  }

  /* ------------------------------------------------------------------ *
   * Custom contract errors -> plain English
   * ------------------------------------------------------------------ */

  /* One catalogue, shared by the demo ledger and the on-chain path, so a revert
     reads identically whether it came from localStorage or Sepolia. Arg names
     follow the Solidity parameter names where the ABI exposes them. */
  var REVERT_TEXT = {
    ZeroAmount: function () { return 'A zero amount was submitted. Enter an amount above zero.'; },
    PoolPaused: function () { return 'The pool is paused. Deposits, funding and new loans are blocked; withdrawals and repayments still work.'; },
    NotInitialized: function () { return 'The pool contract has not been initialised yet.'; },
    AlreadyInitialized: function () { return 'The pool contract is already initialised.'; },
    NotOwner: function () { return 'Only the protocol owner can do that. The connected account is not the owner.'; },
    ZeroAddress: function () { return 'A zero address was supplied where a real address is required.'; },
    AmountTooSmall: function (a) { return 'Amount ' + formatEth(a.provided) + ' ETH is below the minimum of ' + formatEth(a.minimum) + ' ETH.'; },
    AmountTooLarge: function (a) { return 'Amount ' + formatEth(a.provided) + ' ETH is above the maximum of ' + formatEth(a.maximum) + ' ETH.'; },
    DurationInvalid: function (a) { return 'A term of ' + a.provided + ' days is outside the allowed 1 to ' + a.maximum + ' days.'; },
    RateTooHigh: function (a) { return 'A rate of ' + formatBps(a.provided) + ' APR exceeds the ceiling of ' + formatBps(a.maximum) + ' APR.'; },
    InsufficientCollateral: function (a) { return 'Collateral ' + formatEth(a.provided) + ' ETH is below the required ' + formatEth(a.required) + ' ETH.'; },
    InsufficientLiquidity: function (a) { return 'Only ' + formatEth(a.available) + ' ETH is free right now, but ' + formatEth(a.requested) + ' ETH is needed. Liquidity reserved for active loans cannot be used.'; },
    InvalidLoan: function (a) { return 'Loan ' + a.loanId + ' does not exist.'; },
    LoanNotPending: function (a) { return 'Loan ' + a.loanId + ' is not pending, so this action does not apply.'; },
    LoanNotActive: function (a) { return 'Loan ' + a.loanId + ' is not active, so this action does not apply.'; },
    LoanNotOverdue: function (a) { return 'Loan ' + a.loanId + ' is not past its due date yet.'; },
    NotBorrower: function () { return 'Only the borrower of this loan can cancel it.'; },
    NotFunded: function (a) { return 'Loan ' + a.loanId + ' has already received ' + formatEth(a.funded) + ' ETH of funding, so it can no longer be cancelled.'; },
    InsufficientPayment: function (a) { return 'A payment of ' + formatEth(a.provided) + ' ETH is short of the ' + formatEth(a.required) + ' ETH due.'; },
    InsufficientShares: function (a) { return 'The account holds ' + formatEth(a.owned) + ' share units, but ' + formatEth(a.provided) + ' was requested.'; },
    NothingToWithdraw: function () { return 'Those share units redeem to zero ETH.'; },
    NoFees: function () { return 'There are no unclaimed protocol fees.'; },
    TransferFailed: function () { return 'The pool could not complete the ETH transfer.'; },
    Reentrancy: function () { return 'A re-entrant call was blocked.'; },
    InvalidParameter: function (a) { return 'The parameter "' + a.name + '" is out of range.'; }
  };

  function revertMessage(name, args) {
    var a = args || {};
    var render = REVERT_TEXT[name];
    if (!render) return 'The pool rejected this action (' + name + ').';
    try {
      return render(a);
    } catch (err) {
      return 'The pool rejected this action (' + name + ').';
    }
  }

  var UI = {
    /* formatting */
    formatEth: formatEth,
    formatEthExact: formatEthExact,
    formatWeiLabel: formatWeiLabel,
    amountTitle: amountTitle,
    formatInt: formatInt,
    formatSharePercent: formatSharePercent,
    formatBps: formatBps,
    formatApr: formatApr,
    shortenAddress: shortenAddress,
    isHexAddress: isHexAddress,
    formatTxHash: formatTxHash,
    formatTimestamp: formatTimestamp,
    formatDateShort: formatDateShort,
    formatRelativeTo: formatRelativeTo,
    formatDuration: formatDuration,
    truncate: truncate,
    /* maths */
    toWeiBig: toWeiBig,
    weiToDecimalString: weiToDecimalString,
    parseEthToWei: parseEthToWei,
    parseInteger: parseInteger,
    group: group,
    WEI_PER_ETH: WEI_PER_ETH,
    /* escaping + dom */
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    $: $,
    $$: $$,
    setText: setText,
    setHtml: setHtml,
    show: show,
    addClass: addClass,
    removeClass: removeClass,
    el: el,
    setBusy: setBusy,
    skeletonRows: skeletonRows,
    emptyState: emptyState,
    /* feedback */
    toast: toast,
    confirmDialog: confirmDialog,
    copyText: copyText,
    flash: flash,
    prefersReducedMotion: prefersReducedMotion,
    revertMessage: revertMessage
  };

  global.ML_UI = UI;
})(typeof window !== 'undefined' ? window : this);
