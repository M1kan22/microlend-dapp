/* MicroLend — application orchestration.
 *
 * Boots the page, decides between the offline demo ledger and the real chain,
 * routes every read and write through one adapter, and renders the whole board.
 * All user-visible strings inserted into the DOM pass through ML_UI.escapeHtml.
 */
(function (global) {
  'use strict';

  var CFG = global.ML_CONFIG;
  var UI = global.ML_UI;
  var API = global.ML_API;
  var WALLET = global.ML_WALLET;
  var CONTRACT = global.ML_CONTRACT;
  var DEMO = global.ML_DEMO;
  var DOC = global.document;

  var HISTORY_KEY = 'ml.history.v1';
  var HISTORY_LIMIT = 200;
  var REFRESH_MS = 15000;

  var STATE = {
    mode: 'demo',
    modeReason: '',
    address: null,
    remote: false,          /* a Flask backend answered GET /api/config */
    probed: false,
    backendOnline: null,
    demoActor: null,        /* which simulated account the demo acts as */
    stats: null,
    params: null,
    owner: null,
    treasury: null,
    position: null,
    loans: [],
    history: [],
    audit: null,
    scope: 'mine',
    historyType: '',
    loanQueryDone: false,
    timer: null,
    busy: 0
  };

  /* ------------------------------------------------------------------ *
   * Tiny DOM helpers
   * ------------------------------------------------------------------ */

  function one(selector, root) { return UI.$(selector, root); }
  function many(selector, root) { return UI.$$(selector, root); }

  function fill(selector, text, title) {
    many(selector).forEach(function (node) {
      UI.setText(node, text);
      if (title !== undefined) node.setAttribute('title', title);
    });
  }

  function setError(name, message) {
    var node = one('[data-error="' + name + '"]');
    if (!node) return;
    if (message) {
      node.textContent = message;
      node.removeAttribute('hidden');
    } else {
      node.textContent = '';
      node.setAttribute('hidden', '');
    }
  }

  function setHint(name, message, tone) {
    var node = one('[data-borrow-hint="' + name + '"]');
    if (!node) return;
    node.textContent = message || '';
    if (tone) node.setAttribute('data-tone', tone);
    else node.removeAttribute('data-tone');
  }

  function busyInc() { STATE.busy += 1; }
  function busyDec() { STATE.busy = Math.max(0, STATE.busy - 1); }

  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

  /* ------------------------------------------------------------------ *
   * Persisted local history (chain mode)
   * ------------------------------------------------------------------ */

  function readLocalHistory() {
    try {
      var raw = global.localStorage.getItem(HISTORY_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map(function (row) {
        return {
          timestamp: Number(row.timestamp) || 0,
          type: row.type || 'notice',
          status: row.status || 'confirmed',
          from: row.from || '',
          to: row.to || '',
          amountWei: String(row.amountWei || '0'),
          loanId: row.loanId === null || row.loanId === undefined ? null : String(row.loanId),
          hash: row.hash || '',
          note: row.note || '',
          demo: false
        };
      });
    } catch (err) {
      return [];
    }
  }

  function writeLocalHistory(rows) {
    try {
      global.localStorage.setItem(HISTORY_KEY, JSON.stringify(rows.slice(0, HISTORY_LIMIT)));
    } catch (err) { /* storage full or blocked: history simply is not persisted */ }
  }

  function pushLocalHistory(entry) {
    var rows = readLocalHistory();
    rows.unshift(entry);
    writeLocalHistory(rows);
    STATE.history = rows;
  }

  function clearLocalHistory() {
    writeLocalHistory([]);
    STATE.history = [];
  }

  /* ------------------------------------------------------------------ *
   * Mode handling
   * ------------------------------------------------------------------ */

  function decideMode() {
    var decision = CFG.initialMode();
    STATE.mode = decision.demo ? 'demo' : 'chain';
    STATE.modeReason = decision.reason;
  }

  function isDemo() { return STATE.mode === 'demo'; }

  function currentAddress() {
    if (isDemo()) return STATE.demoActor || DEMO.address;
    return WALLET.address();
  }

  /* The account the demo ledger is acting as, with its label for the topbar. */
  function demoActor() {
    var accounts = DEMO.accounts();
    var wanted = String(STATE.demoActor || DEMO.address).toLowerCase();
    for (var i = 0; i < accounts.length; i++) {
      if (accounts[i].address === wanted) return accounts[i];
    }
    STATE.demoActor = accounts.length ? accounts[0].address : DEMO.address;
    return accounts.length ? accounts[0] : {
      address: DEMO.address, label: 'Your demo desk', ethWei: 0n, shares: 0n, shareValue: 0n, isDesk: true
    };
  }

  function canWrite() {
    if (isDemo()) return true;
    return !!WALLET.address();
  }

  function exploreUrl(hash) {
    if (!hash || isDemo()) return '';
    return CFG.explorerTx(hash);
  }

  /* ------------------------------------------------------------------ *
   * Read adapters
   * ------------------------------------------------------------------ */

  function loadPool() {
    if (isDemo()) {
      var stats = DEMO.stats();
      STATE.stats = stats;
      STATE.params = stats.params;
      STATE.owner = stats.owner;
      STATE.treasury = stats.treasury;
      STATE.audit = DEMO.audit();
      return Promise.resolve(stats);
    }
    if (!CONTRACT.available() || !CFG.hasContract()) {
      STATE.stats = null;
      return Promise.reject(new Error(CONTRACT.reason() || 'The pool contract is not reachable.'));
    }
    return CONTRACT.poolStats().then(function (stats) {
      STATE.stats = stats;
      return Promise.all([
        CONTRACT.params().then(function (p) { STATE.params = p; }, function () { STATE.params = null; }),
        CONTRACT.owner().then(function (o) { STATE.owner = o; }, function () { STATE.owner = null; }),
        CONTRACT.treasury().then(function (t) { STATE.treasury = t; }, function () { STATE.treasury = null; })
      ]).then(function () { return stats; });
    });
  }

  function loadPosition() {
    var address = currentAddress();
    if (!address) { STATE.position = null; return Promise.resolve(null); }
    if (isDemo()) {
      STATE.position = DEMO.position(address);
      return Promise.resolve(STATE.position);
    }
    /* Prefer the chain: the backend indexes loans and events but not share
       balances, so its `sharesWei` is always zero. Fall back to the API when the
       contract cannot be read (no RPC, no wallet). */
    if (CONTRACT.available() && CFG.hasContract()) {
      return loadPositionOnChain(address);
    }
    if (STATE.backendOnline) {
      return API.position(address).then(function (data) {
        STATE.position = normaliseApiPosition(data, address);
        return STATE.position;
      }, function () {
        STATE.position = null;
        return null;
      });
    }
    STATE.position = null;
    return Promise.resolve(null);
  }

  function loadPositionOnChain(address) {
    if (!CONTRACT.available() || !CFG.hasContract()) { STATE.position = null; return Promise.resolve(null); }
    return CONTRACT.position(address).then(function (pos) {
      pos.ethBalance = WALLET.balanceWei();
      STATE.position = pos;
      return pos;
    }, function () {
      STATE.position = {
        address: address, shares: 0n, shareValue: 0n, collateralLocked: 0n,
        activeLoans: 0n, pendingLoans: 0n, outstandingDebt: 0n,
        ethBalance: WALLET.balanceWei(), label: ''
      };
      return STATE.position;
    });
  }

  function normaliseApiPosition(data, address) {
    var d = data || {};
    var position = d.position || d;
    var big = function (v) {
      try { return BigInt(v === undefined || v === null || v === '' ? 0 : v); } catch (err) { return 0n; }
    };
    return {
      address: address,
      shares: big(position.sharesWei !== undefined ? position.sharesWei : position.shares),
      shareValue: big(position.shareValueWei !== undefined ? position.shareValueWei : position.shareValue),
      collateralLocked: big(position.collateralLockedWei !== undefined ? position.collateralLockedWei : position.collateralLocked),
      activeLoans: big(position.activeLoans),
      pendingLoans: big(position.pendingLoans),
      outstandingDebt: big(position.outstandingDebtWei !== undefined ? position.outstandingDebtWei : position.outstandingDebt),
      ethBalance: WALLET.balanceWei(),
      label: ''
    };
  }

  function loadLoans() {
    var address = currentAddress();
    if (isDemo()) {
      STATE.loans = STATE.scope === 'all' ? DEMO.allLoans() : (address ? DEMO.getUserLoans(address) : []);
      STATE.loanQueryDone = true;
      return Promise.resolve(STATE.loans);
    }
    if (STATE.backendOnline) {
      var params = { limit: 100 };
      if (STATE.scope === 'mine' && address) params.borrower = address;
      return API.loans(params).then(function (data) {
        var items = (data && data.items) || [];
        STATE.loans = items.map(normaliseApiLoan);
        STATE.loanQueryDone = true;
        return STATE.loans;
      }, function () {
        return loadLoansOnChain(address);
      });
    }
    return loadLoansOnChain(address);
  }

  function loadLoansOnChain(address) {
    if (!CONTRACT.available() || !CFG.hasContract()) {
      STATE.loans = [];
      STATE.loanQueryDone = true;
      return Promise.resolve([]);
    }
    if (STATE.scope === 'all') {
      return CONTRACT.poolStats().then(function (stats) {
        var count = Number(stats.loanCount);
        if (!count) return [];
        var ids = [];
        for (var i = 1; i <= count; i++) ids.push(BigInt(i));
        var out = [];
        var queue = ids.slice();
        function next() {
          if (!queue.length) return Promise.resolve();
          return CONTRACT.getLoan(queue.shift()).then(function (loan) { out.push(loan); return next(); }, function () { return next(); });
        }
        var workers = [];
        for (var w = 0; w < Math.min(6, ids.length); w++) workers.push(next());
        return Promise.all(workers).then(function () {
          out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
          STATE.loans = out;
          STATE.loanQueryDone = true;
          return out;
        });
      }, function () {
        STATE.loans = [];
        STATE.loanQueryDone = true;
        return [];
      });
    }
    if (!address) {
      STATE.loans = [];
      STATE.loanQueryDone = true;
      return Promise.resolve([]);
    }
    return CONTRACT.loansOf(address).then(function (loans) {
      STATE.loans = loans;
      STATE.loanQueryDone = true;
      return loans;
    }, function () {
      STATE.loans = [];
      STATE.loanQueryDone = true;
      return [];
    });
  }

  function normaliseApiLoan(item) {
    var big = function (v) {
      try { return BigInt(v === undefined || v === null || v === '' ? 0 : v); } catch (err) { return 0n; }
    };
    var statusMap = { PENDING: 1, ACTIVE: 2, REPAID: 3, LIQUIDATED: 4, CANCELLED: 5, CANCELED: 5, NONE: 0 };
    /* The backend sends both `statusCode` (uint8) and `status` (name); prefer the
       number so the demo and chain paths agree on the enum. */
    var status = item.statusCode !== undefined && item.statusCode !== null
      ? Number(item.statusCode)
      : (typeof item.status === 'number' ? item.status : (statusMap[String(item.status || '').toUpperCase()] || 0));
    var principal = big(item.principalWei);
    var funded = big(item.fundedWei !== undefined ? item.fundedWei : item.amountFundedWei);
    return {
      id: big(item.loanId !== undefined ? item.loanId : item.id),
      borrower: item.borrower || item.borrowerAddress || '',
      principal: principal,
      collateral: big(item.collateralWei),
      interest: big(item.interestWei),
      rateBps: big(item.rateBps),
      durationDays: big(item.durationDays),
      startTime: big(item.startTime),
      dueDate: big(item.dueDate),
      amountFunded: funded,
      status: status,
      statusName: CONTRACT.STATUS[status] || 'Unknown',
      amountDue: item.totalDueWei !== undefined && item.totalDueWei !== null
        ? big(item.totalDueWei)
        : (item.amountDueWei !== undefined && item.amountDueWei !== null ? big(item.amountDueWei) : null),
      lateFee: big(item.lateFeeWei),
      overdue: item.isOverdue !== undefined ? !!item.isOverdue : !!item.overdue,
      remainingToFund: item.remainingWei !== undefined && item.remainingWei !== null
        ? big(item.remainingWei)
        : (principal > funded ? principal - funded : 0n),
      mode: 'chain',
      borrowerLabel: ''
    };
  }

  /* The backend stores unix seconds, but a value from another source may be
     milliseconds or an ISO string; normalise rather than render 1970. */
  function toUnixSeconds(value) {
    var fallback = Math.floor(Date.now() / 1000);
    if (value === null || value === undefined || value === '') return fallback;
    if (typeof value === 'number' && isFinite(value)) {
      return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
    }
    var s = String(value);
    if (/^\d+$/.test(s)) {
      var n = Number(s);
      return n > 1e12 ? Math.floor(n / 1000) : n;
    }
    var ms = Date.parse(s);
    return isFinite(ms) ? Math.floor(ms / 1000) : fallback;
  }

  function loadHistory() {
    if (isDemo()) {
      STATE.history = DEMO.transactions({});
      return Promise.resolve(STATE.history);
    }
    var local = readLocalHistory();
    if (STATE.backendOnline) {
      var params = { limit: 100 };
      var address = currentAddress();
      if (address) params.address = address;
      return API.transactions(params).then(function (data) {
        var items = (data && data.items) || [];
        var remote = items.map(function (row) {
          return {
            timestamp: toUnixSeconds(row.createdAt !== undefined ? row.createdAt : row.timestamp),
            type: String(row.type || 'notice').toLowerCase(),
            status: row.status || 'confirmed',
            from: row.address || row.fromAddress || row.from || '',
            to: row.toAddress || row.to || '',
            amountWei: String(row.amountWei || 0),
            loanId: row.loanId === null || row.loanId === undefined ? null : String(row.loanId),
            hash: row.txHash || row.hash || '',
            note: row.description || row.note || '',
            demo: !!row.isDemo
          };
        });
        STATE.history = remote.concat(local).sort(function (a, b) { return b.timestamp - a.timestamp; });
        return STATE.history;
      }, function () {
        STATE.history = local;
        return local;
      });
    }
    STATE.history = local;
    return Promise.resolve(local);
  }

  /* ------------------------------------------------------------------ *
   * Rendering — topbar, banner, footer
   * ------------------------------------------------------------------ */

  /* The wallet button carries two facts, so they are set as two elements rather
     than one run of text: the identity, then the balance. */
  function setWalletLabel(identity, balance) {
    var node = one('[data-wallet-label]');
    if (!node) return;
    if (!identity) {
      UI.setText(node, balance);
      return;
    }
    UI.setHtml(node,
      '<span class="wallet-identity">' + UI.escapeHtml(identity) + '</span>' +
      '<span class="wallet-balance">' + UI.escapeHtml(balance) + '</span>');
  }

  function renderTopbar() {
    var badge = one('#chain-badge');
    var label = one('[data-chain-label]');
    var button = one('#wallet-button');

    if (isDemo()) {
      if (badge) badge.setAttribute('data-state', 'demo');
      UI.setText(label, 'Demo ledger');
      var actor = demoActor();
      if (button) {
        button.disabled = false;
        button.removeAttribute('title');
        button.setAttribute('data-mode', 'demo');
      }
      setWalletLabel(UI.truncate(actor.label, 22), UI.formatEth(actor.ethWei, { dp: 4 }) + ' ETH');
      return;
    }

    var chainId = WALLET.chainId();
    if (!WALLET.available()) {
      if (badge) badge.setAttribute('data-state', 'warn');
      UI.setText(label, 'No wallet detected');
    } else if (chainId === null) {
      if (badge) badge.setAttribute('data-state', '');
      UI.setText(label, 'Wallet not connected');
    } else if (CFG.isSepolia(chainId)) {
      if (badge) badge.setAttribute('data-state', 'ok');
      UI.setText(label, CFG.chainName(chainId));
    } else {
      if (badge) badge.setAttribute('data-state', 'warn');
      UI.setText(label, 'Wrong network: ' + CFG.chainName(chainId));
    }

    if (button) button.setAttribute('data-mode', 'chain');
    if (!WALLET.address()) {
      setWalletLabel('', WALLET.available() ? 'Connect wallet' : 'No wallet found');
      if (button) {
        button.disabled = !WALLET.available();
        if (!WALLET.available()) {
          button.setAttribute('title', 'No MetaMask-compatible wallet was detected. Install one, or stay in demo mode.');
        } else {
          button.removeAttribute('title');
        }
      }
    } else {
      var balance = WALLET.balanceWei();
      setWalletLabel(UI.shortenAddress(WALLET.address()), UI.formatEth(balance, { dp: 4 }) + ' ETH');
      if (button) {
        button.disabled = false;
        button.setAttribute('title', WALLET.address() + ' — click to refresh the balance and account');
      }
    }
  }

  function bannerAction(label, action, opts) {
    var o = opts || {};
    return '<button type="button" class="' + (o.primary ? 'btn btn-primary' : 'chip') + '" data-banner-action="' +
      UI.escapeAttr(action) + '">' + UI.escapeHtml(label) + '</button>';
  }

  function renderBanner() {
    var banner = one('#mode-banner');
    if (!banner) return;

    if (isDemo()) {
      banner.setAttribute('data-kind', 'demo');
      var stats = STATE.stats || DEMO.stats();
      var accounts = DEMO.accounts();
      var current = currentAddress();
      var options = accounts.map(function (acct) {
        return '<option value="' + UI.escapeAttr(acct.address) + '"' +
          (acct.address === String(current).toLowerCase() ? ' selected' : '') + '>' +
          UI.escapeHtml(acct.label + ' — ' + UI.formatEth(acct.ethWei) + ' ETH') + '</option>';
      }).join('');
      banner.innerHTML =
        '<div class="shell banner-inner">' +
          '<span class="banner-badge">DEMO DATA — no real chain</span>' +
          '<p class="banner-text">A local ledger mirroring the contract exactly: wei arithmetic, simple interest, ' +
            '10% fee on interest, 5% liquidation penalty, 1% late fee per started 30 days. Nothing is broadcast. ' +
            'Ledger time is <strong>' + UI.escapeHtml(UI.formatTimestamp(stats.blockTimestamp)) + '</strong>.</p>' +
          '<div class="banner-actions">' +
            '<label class="actor-select" for="demo-actor">Acting as</label>' +
            '<select id="demo-actor" name="demo-actor">' + options + '</select>' +
            bannerAction('Advance 1 day', 'clock-day') +
            bannerAction('Advance 30 days', 'clock-month') +
            bannerAction('Jump past the next due date', 'clock-due') +
            bannerAction('Reset ledger', 'reset') +
            bannerAction('Restore sample book', 'reseed') +
            (!STATE.probed && !STATE.remote ? bannerAction('Look for a Flask backend', 'find-backend') : '') +
            (STATE.remote ? bannerAction('Switch to chain mode', 'to-chain', { primary: true }) : '') +
          '</div>' +
        '</div>';
      return;
    }

    var chainId = WALLET.chainId();
    if (!WALLET.available()) {
      banner.setAttribute('data-kind', 'warn');
      banner.innerHTML =
        '<div class="shell banner-inner">' +
          '<span class="banner-badge">No wallet</span>' +
          '<p class="banner-text">This build is pointed at a pool contract, but no MetaMask-compatible wallet is in this browser, ' +
            'so nothing can be signed. Reads still work through the configured RPC endpoint.</p>' +
          '<div class="banner-actions">' + bannerAction('Use demo mode instead', 'to-demo', { primary: true }) + '</div>' +
        '</div>';
      return;
    }
    if (chainId !== null && !CFG.isSepolia(chainId)) {
      banner.setAttribute('data-kind', 'warn');
      banner.innerHTML =
        '<div class="shell banner-inner">' +
          '<span class="banner-badge">Wrong network</span>' +
          '<p class="banner-text">The wallet is on <strong>' + UI.escapeHtml(CFG.chainName(chainId)) +
            '</strong>. MicroLend is deployed on ' + UI.escapeHtml(CFG.chainName(CFG.chainId)) +
            ' (chain ' + UI.escapeHtml(String(CFG.chainId)) + '). Transactions would fail or spend real ETH.</p>' +
          '<div class="banner-actions">' +
            bannerAction('Switch network', 'switch-chain', { primary: true }) +
            bannerAction('Use demo mode', 'to-demo') +
          '</div>' +
        '</div>';
      return;
    }
    if (!WALLET.address()) {
      banner.setAttribute('data-kind', 'note');
      banner.innerHTML =
        '<div class="shell banner-inner">' +
          '<span class="banner-badge">Read-only</span>' +
          '<p class="banner-text">The pool is being read from the chain. Connect a wallet to supply, borrow, repay or liquidate.</p>' +
          '<div class="banner-actions">' + bannerAction('Use demo mode', 'to-demo') + '</div>' +
        '</div>';
      return;
    }
    banner.setAttribute('data-kind', 'note');
    banner.innerHTML =
      '<div class="shell banner-inner">' +
        '<span class="banner-badge">Connected</span>' +
        '<p class="banner-text">Signed in as <strong>' + UI.escapeHtml(UI.shortenAddress(WALLET.address())) +
          '</strong> on ' + UI.escapeHtml(CFG.chainName(chainId || CFG.chainId)) +
          (STATE.backendOnline ? '. The Flask backend is indexing the pool.' : '. The backend is offline, so records stay in this browser.') +
        '</p>' +
        '<div class="banner-actions">' + bannerAction('Use demo mode', 'to-demo') + '</div>' +
      '</div>';
  }

  function renderRuntimeNote() {
    var note = one('#runtime-note');
    if (!note) return;
    var messages = [];
    if (!CONTRACT.available()) {
      messages.push(global.__ML_ETHERS_LOCAL_FAILED
        ? 'ethers could not be loaded from vendor/ethers.umd.min.js and the CDN fallback did not answer, so chain reads are off. Demo mode is unaffected.'
        : 'ethers is not loaded, so chain reads are off. Demo mode is unaffected.');
    }
    if (!isDemo() && STATE.backendOnline === false) {
      messages.push('The Flask backend is not answering, so loan records come from the chain and your own browser only.');
    }
    if (!isDemo() && CFG.hasContract() === false) {
      messages.push('No pool contract address is configured.');
    }
    if (messages.length) {
      note.textContent = messages.join(' ');
      note.removeAttribute('hidden');
    } else {
      note.textContent = '';
      note.setAttribute('hidden', '');
    }
  }

  function renderFooter() {
    var contract = CFG.contractAddress || (isDemo() ? 'none (offline demo ledger)' : 'not configured');
    var contractNode = one('[data-footer="contract"]');
    if (contractNode) {
      if (CFG.hasContract()) {
        contractNode.innerHTML = '<button type="button" class="chip" data-copy="' +
          UI.escapeAttr(CFG.contractAddress) + '">' + UI.escapeHtml(CFG.contractAddress) + '</button>';
      } else {
        UI.setText(contractNode, contract);
      }
    }
    fill('[data-footer="network"]', isDemo()
      ? 'Sepolia testnet (chain 11155111) — simulated locally'
      : CFG.chainName(CFG.chainId) + ' (chain ' + CFG.chainId + ')');
    var explorer = one('[data-footer="explorer"]');
    if (explorer) {
      if (CFG.explorerBase && CFG.hasContract()) {
        explorer.href = CFG.explorerAddress(CFG.contractAddress);
        UI.setText(explorer, 'View the pool on the block explorer');
      } else {
        explorer.removeAttribute('href');
        UI.setText(explorer, isDemo() ? 'No explorer: demo ledger' : 'No explorer configured');
      }
    }
    var build = 'MicroLend ' + CFG.buildLabel + ' — ' + (isDemo() ? 'demo ledger' : 'chain mode') +
      ', ethers ' + (CONTRACT.available() && global.ethers && global.ethers.version ? global.ethers.version : 'not loaded');
    fill('[data-footer="build"]', build);
  }

  /* ------------------------------------------------------------------ *
   * Rendering — hero, gauge, KPIs
   * ------------------------------------------------------------------ */

  function utilisationPercent(stats) {
    var total = stats.totalLiquidity || 0n;
    var borrowed = stats.reservedLiquidity || 0n;
    if (total === 0n) return { text: '0.0', value: 0 };
    var scaled = (borrowed * 1000n) / total; /* tenths of a percent */
    var whole = scaled / 10n;
    var tenth = scaled % 10n;
    return { text: whole.toString() + '.' + tenth.toString(), value: Number(whole) + Number(tenth) / 10 };
  }

  function renderHero() {
    var stats = STATE.stats;
    if (!stats) return;

    var util = utilisationPercent(stats);
    fill('[data-gauge-figure]', util.text);
    var gauge = one('#gauge');
    if (gauge) {
      gauge.setAttribute('aria-label', 'Pool utilisation ' + util.text + ' percent: ' +
        UI.formatEth(stats.reservedLiquidity) + ' ETH lent out of ' + UI.formatEth(stats.totalLiquidity) + ' ETH supplied');
    }
    var fillNode = one('#gauge-fill');
    if (fillNode) fillNode.style.width = Math.max(0, Math.min(100, util.value)) + '%';
    var marker = one('#gauge-marker');
    if (marker) {
      marker.style.left = Math.max(0, Math.min(100, util.value)) + '%';
      marker.style.opacity = util.value > 0 ? '0.55' : '0';
    }

    var borrowedTitle = UI.amountTitle(stats.reservedLiquidity);
    var availableTitle = UI.amountTitle(stats.availableLiquidity);
    fill('[data-gauge-borrowed]', UI.formatWeiLabel(stats.reservedLiquidity), borrowedTitle);
    fill('[data-gauge-available]', UI.formatWeiLabel(stats.availableLiquidity), availableTitle);

    var flag = one('#pool-flag');
    if (flag) {
      if (stats.paused) {
        UI.setText(flag, 'PAUSED');
        flag.removeAttribute('hidden');
        flag.setAttribute('title', 'The owner has paused the pool: deposits, funding and new loans are blocked.');
      } else {
        flag.setAttribute('hidden', '');
      }
    }

    var loans = STATE.loans.length ? STATE.loans : [];
    var active = 0, pending = 0, overdue = 0;
    loans.forEach(function (loan) {
      if (Number(loan.status) === 2) active++;
      if (Number(loan.status) === 1) pending++;
      if (isOverdue(loan)) overdue++;
    });
    fill('[data-hero="loanBook"]',
      UI.formatInt(stats.loanCount) + ' loans opened — ' + active + ' active, ' + pending + ' awaiting funding, ' + overdue + ' overdue',
      'Total loan requests created, with the current counts by status');

    if (STATE.params) {
      var p = STATE.params;
      fill('[data-hero="terms"]',
        'Simple interest, frozen when the loan is requested. Ceiling ' + UI.formatBps(p.maxRateBps) +
        ' APR, terms up to ' + p.maxDurationDays + ' days, protocol fee ' + UI.formatBps(p.feeBps) + ' of interest charged.');
      fill('[data-hero="liquidation"]',
        'Any address can liquidate once the due date passes. The pool takes up to ' + UI.formatBps(p.penaltyBps) +
        ' over the debt, refunds excess collateral, and writes off only a real shortfall. Late fee ' +
        UI.formatBps(p.lateFeeBps) + ' per started 30 days.');
    }
  }

  /* Overdue is a function of the ledger clock in demo mode and of wall-clock
     time on chain, so it must be asked of the active mode rather than computed
     from Date.now() in both cases. */
  function isOverdue(loan) {
    if (!loan || Number(loan.status) !== 2) return false;
    if (loan.overdue === true) return true;
    var due = loan.dueDate ? BigInt(loan.dueDate) : 0n;
    if (due <= 0n) return false;
    var now = isDemo() ? BigInt(DEMO.chainTime()) : BigInt(Math.floor(Date.now() / 1000));
    return now > due;
  }

  function renderKpis() {
    var stats = STATE.stats;
    if (!stats) return;

    var totalBorrowed = stats.reservedLiquidity;
    var cells = [
      ['totalLiquidity', UI.formatEth(stats.totalLiquidity), UI.amountTitle(stats.totalLiquidity),
        'Supplied ' + UI.formatEth(stats.totalDeposited) + ' ETH — fees taken ' + UI.formatEth(stats.totalFeesCollected) + ' ETH'],
      ['availableLiquidity', UI.formatEth(stats.availableLiquidity), UI.amountTitle(stats.availableLiquidity),
        'free liquidity, excluding ' + UI.formatEth(stats.reservedLiquidity) + ' ETH reserved for active loans'],
      ['totalBorrowed', UI.formatEth(totalBorrowed), UI.amountTitle(totalBorrowed),
        'principal outstanding across active loans'],
      ['sharePrice', UI.formatEth(stats.sharePrice, { dp: 6 }), UI.amountTitle(stats.sharePrice),
        'per 1.000000 share unit'],
      ['totalInterestEarned', UI.formatEth(stats.totalInterestEarned), UI.amountTitle(stats.totalInterestEarned),
        'gross interest charged to borrowers, lifetime'],
      ['totalBadDebt', UI.formatEth(stats.totalBadDebt), UI.amountTitle(stats.totalBadDebt),
        'principal written off after liquidation, lifetime']
    ];

    cells.forEach(function (cell) {
      fill('[data-kpi="' + cell[0] + '"]', cell[1], cell[2]);
      fill('[data-kpi-note="' + cell[0] + '"]', cell[3]);
    });

    var shareCell = one('[data-kpi-cell="sharePrice"]');
    if (shareCell) shareCell.setAttribute('data-tone', stats.sharePrice > 10n ** 18n ? 'good' : '');
    var debtCell = one('[data-kpi-cell="totalBadDebt"]');
    if (debtCell) debtCell.setAttribute('data-tone', stats.totalBadDebt > 0n ? 'bad' : '');
    var treasury = one('[data-kpi-cell="availableLiquidity"]');
    if (treasury && stats.treasuryBalance > 0n) {
      fill('[data-kpi-note="availableLiquidity"]',
        'free liquidity; ' + UI.formatEth(stats.treasuryBalance) + ' ETH of fees sit unclaimed in the treasury');
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering — supply / borrow forms
   * ------------------------------------------------------------------ */

  function supplyMode() {
    var checked = one('input[name="supply-mode"]:checked');
    return checked ? checked.value : 'deposit';
  }

  function renderSupplyPanel() {
    var mode = supplyMode();
    var deposit = mode === 'deposit';
    var stats = STATE.stats;
    var position = STATE.position;

    UI.setText(one('[data-supply-label]'), deposit ? 'Amount to supply' : 'Share units to burn');
    UI.setText(one('[data-supply-unit]'), deposit ? 'ETH' : 'shares');
    UI.setText(one('#supply-submit'), deposit ? 'Supply ETH' : 'Withdraw ETH');
    fill('[data-panel-meta="supply"]', stats
      ? UI.formatEth(stats.totalLiquidity) + ' ETH supplied in total'
      : '—');

    var hint = one('[data-supply-hint]');
    if (hint) {
      if (deposit) {
        var min = STATE.params ? STATE.params.minDeposit : 0n;
        hint.textContent = 'Minimum supply is ' + UI.formatEth(min) + ' ETH. Shares are minted at the current share price of ' +
          UI.formatEth(stats ? stats.sharePrice : 10n ** 18n, { dp: 6 }) + ' ETH.';
      } else {
        hint.textContent = position
          ? 'You hold ' + UI.formatEth(position.shares) + ' share units, worth ' + UI.formatEth(position.shareValue) +
            ' ETH. Withdrawals are paid from free liquidity only.'
          : 'Connect a wallet to see your share units.';
      }
      hint.removeAttribute('data-tone');
    }

    var amountInput = one('#supply-amount');
    if (amountInput) {
      amountInput.placeholder = deposit ? '0.0000' : '0';
      amountInput.setAttribute('aria-label', deposit ? 'Amount to supply in ETH' : 'Share units to burn');
    }
    renderSupplyReceipt();
  }

  function renderSupplyReceipt() {
    var stats = STATE.stats;
    var position = STATE.position;
    var deposit = supplyMode() === 'deposit';
    var raw = one('#supply-amount') ? one('#supply-amount').value : '';

    if (deposit) {
      var parsed = UI.parseEthToWei(raw);
      if (parsed.ok && stats) {
        var shares = stats.totalShares === 0n
          ? (parsed.wei > 1n ? parsed.wei - 1n : 0n)
          : (stats.totalLiquidity === 0n ? parsed.wei : (parsed.wei * stats.totalShares) / stats.totalLiquidity);
        fill('[data-supply="receive"]', UI.formatEth(shares) + ' shares', UI.amountTitle(shares, 'share units'));
        fill('[data-supply="equity"]', UI.formatEth(parsed.wei) + ' ETH', UI.amountTitle(parsed.wei));
      } else {
        fill('[data-supply="receive"]', '—');
        fill('[data-supply="equity"]', '—');
      }
    } else {
      var sharesParsed = UI.parseInteger(raw);
      if (sharesParsed.ok && stats && stats.totalShares > 0n) {
        var assets = (sharesParsed.value * stats.totalLiquidity) / stats.totalShares;
        fill('[data-supply="receive"]', UI.formatEth(assets) + ' ETH', UI.amountTitle(assets));
        fill('[data-supply="equity"]', position ? UI.formatEth(position.shareValue) + ' ETH held' : '—', position ? UI.amountTitle(position.shareValue) : '');
      } else {
        fill('[data-supply="receive"]', '—');
        fill('[data-supply="equity"]', position ? UI.formatEth(position.shareValue) + ' ETH held' : '—');
      }
    }
    fill('[data-supply="sharePrice"]', stats ? UI.formatEth(stats.sharePrice, { dp: 6 }) + ' ETH' : '—',
      stats ? UI.amountTitle(stats.sharePrice, 'ETH per 1.00 share unit') : '');
  }

  function parsePercentToBps(input) {
    var raw = String(input === null || input === undefined ? '' : input).trim().replace(/%/g, '').replace(/,/g, '');
    if (!raw) return { ok: false, reason: 'Enter a rate.' };
    if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
      return { ok: false, reason: 'Use a percentage with at most two decimal places, for example 12.50.' };
    }
    var bits = raw.split('.');
    var frac = (bits[1] || '') + '00';
    var bps = BigInt(bits[0]) * 100n + BigInt(frac.slice(0, 2));
    return { ok: true, bps: bps };
  }

  function borrowInput() {
    var principal = UI.parseEthToWei(one('#borrow-principal') ? one('#borrow-principal').value : '');
    var rate = parsePercentToBps(one('#borrow-rate') ? one('#borrow-rate').value : '');
    var duration = UI.parseInteger(one('#borrow-duration') ? one('#borrow-duration').value : '');
    var collateral = UI.parseEthToWei(one('#borrow-collateral') ? one('#borrow-collateral').value : '');
    return { principal: principal, rate: rate, duration: duration, collateral: collateral };
  }

  function renderBorrowPanel() {
    var stats = STATE.stats;
    var params = STATE.params;
    if (!stats || !params) return;
    var input = borrowInput();

    fill('[data-panel-meta="borrow"]', UI.formatEth(stats.availableLiquidity) + ' ETH available to lend');

    var hintPrincipal = one('[data-borrow-hint="principal"]');
    if (hintPrincipal) {
      if (input.principal.ok) {
        var withinMin = input.principal.wei >= params.minLoanPrincipal;
        var withinMax = input.principal.wei <= params.maxLoanPrincipal;
        hintPrincipal.textContent = 'Between ' + UI.formatEth(params.minLoanPrincipal) + ' and ' +
          UI.formatEth(params.maxLoanPrincipal) + ' ETH.';
        hintPrincipal.setAttribute('data-tone', withinMin && withinMax ? 'ok' : 'bad');
      } else {
        hintPrincipal.textContent = 'Between ' + UI.formatEth(params.minLoanPrincipal) + ' and ' +
          UI.formatEth(params.maxLoanPrincipal) + ' ETH.';
        hintPrincipal.removeAttribute('data-tone');
      }
    }

    var hintRate = one('[data-borrow-hint="rate"]');
    if (hintRate) {
      if (input.rate.ok) {
        var over = input.rate.bps > params.maxRateBps;
        hintRate.textContent = input.rate.bps.toString() + ' bps, charged once over the whole term. Ceiling ' +
          UI.formatBps(params.maxRateBps) + ' APR.';
        hintRate.setAttribute('data-tone', over ? 'bad' : 'ok');
      } else {
        hintRate.textContent = 'Annual simple interest. Ceiling ' + UI.formatBps(params.maxRateBps) + ' APR.';
        hintRate.removeAttribute('data-tone');
      }
    }

    var hintDuration = one('[data-borrow-hint="duration"]');
    if (hintDuration) {
      var d = input.duration.ok ? input.duration.value : null;
      var badDuration = d !== null && (d === 0n || d > params.maxDurationDays);
      hintDuration.textContent = '1 to ' + params.maxDurationDays.toString() + ' days. Interest is frozen at request time.';
      if (badDuration) hintDuration.setAttribute('data-tone', 'bad');
      else hintDuration.removeAttribute('data-tone');
    }

    var required = 0n;
    var interest = 0n;
    if (input.principal.ok && input.rate.ok && input.duration.ok) {
      var quote = isDemo()
        ? DEMO.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value)
        : CONTRACT.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value, params.minCollateralBps);
      required = quote.requiredCollateral;
      interest = quote.totalDue - input.principal.wei;
    }

    var hintCollateral = one('[data-borrow-hint="collateral"]');
    if (hintCollateral) {
      if (required > 0n) {
        var short = input.collateral.ok && input.collateral.wei < required;
        hintCollateral.textContent = 'At least ' + UI.formatEth(required) + ' ETH (' + UI.formatBps(params.minCollateralBps) +
          ' of principal). Locked until the loan is repaid or cancelled.';
        hintCollateral.setAttribute('data-tone', short ? 'bad' : 'ok');
      } else {
        hintCollateral.textContent = 'At least ' + UI.formatBps(params.minCollateralBps) + ' of the principal, held until the loan closes.';
        hintCollateral.removeAttribute('data-tone');
      }
    }

    var fee = (interest * params.feeBps) / 10000n;
    fill('[data-quote="interest"]', UI.formatEth(interest) + ' ETH', UI.amountTitle(interest));
    fill('[data-quote="totalDue"]', UI.formatEth(input.principal.ok ? input.principal.wei + interest : interest) + ' ETH',
      UI.amountTitle(input.principal.ok ? input.principal.wei + interest : interest));
    fill('[data-quote="fee"]', UI.formatEth(fee) + ' ETH', UI.amountTitle(fee));
    fill('[data-quote="payout"]', UI.formatEth(input.principal.ok ? input.principal.wei : 0n) + ' ETH',
      UI.amountTitle(input.principal.ok ? input.principal.wei : 0n));
    var nowSeconds = isDemo() ? BigInt(DEMO.chainTime()) : BigInt(Math.floor(Date.now() / 1000));
    var dueSeconds = input.duration.ok ? nowSeconds + input.duration.value * 86400n : 0n;
    fill('[data-quote="due"]', dueSeconds > 0n ? UI.formatTimestamp(dueSeconds) : '—',
      dueSeconds > 0n ? UI.formatRelativeTo(dueSeconds, nowSeconds) : '');

    var availability = one('#borrow-availability');
    if (availability) {
      if (!input.principal.ok || input.principal.wei === 0n) {
        availability.textContent = 'Enter a principal to see whether the pool can fund it immediately.';
      } else if (input.principal.wei <= stats.availableLiquidity) {
        availability.textContent = 'The pool holds ' + UI.formatEth(stats.availableLiquidity) +
          ' ETH of free liquidity, so this loan activates immediately and the principal is paid out in the same transaction.';
      } else {
        availability.textContent = 'The pool holds only ' + UI.formatEth(stats.availableLiquidity) +
          ' ETH of free liquidity, so this request will wait in Pending until it is funded with fundLoan() or cancelled.';
      }
      availability.removeAttribute('data-tone');
    }
  }

  /* ------------------------------------------------------------------ *
   * Rendering — loan book
   * ------------------------------------------------------------------ */

  var STATUS_LABEL = { 0: 'None', 1: 'Pending', 2: 'Active', 3: 'Repaid', 4: 'Liquidated', 5: 'Cancelled' };

  function loanActions(loan) {
    var address = currentAddress();
    var mine = address && loan.borrower && String(loan.borrower).toLowerCase() === String(address).toLowerCase();
    var actions = [];
    var writable = canWrite();

    if (loan.status === 2) {
      actions.push({
        action: 'repay', label: 'Repay', primary: true,
        enabled: writable,
        reason: writable ? '' : 'Connect a wallet to repay.'
      });
      var overdue = isOverdue(loan);
      actions.push({
        action: 'liquidate', label: 'Liquidate', danger: true,
        enabled: writable && overdue,
        reason: writable
          ? (overdue ? '' : 'Only possible once the due date has passed.')
          : 'Connect a wallet to liquidate.'
      });
    } else if (loan.status === 1) {
      var remaining = loan.remainingToFund !== undefined && loan.remainingToFund !== null
        ? BigInt(loan.remainingToFund)
        : BigInt(loan.principal) - BigInt(loan.amountFunded || 0);
      actions.push({
        action: 'fund', label: 'Fund', primary: true,
        enabled: writable && remaining > 0n,
        reason: writable ? '' : 'Connect a wallet to fund this loan.'
      });
      var cancellable = BigInt(loan.amountFunded || 0) === 0n && mine;
      actions.push({
        action: 'cancel', label: 'Cancel',
        enabled: writable && cancellable,
        reason: !writable ? 'Connect a wallet to cancel.'
          : (BigInt(loan.amountFunded || 0) > 0n ? 'Already partly funded, so it can no longer be cancelled.'
            : 'Only the borrower can cancel a pending request.')
      });
    }
    return actions;
  }

  function renderLoans() {
    var body = one('#loans-body');
    if (!body) return;

    fill('[data-panel-meta="loans"]', STATE.loans.length
      ? STATE.loans.length + (STATE.scope === 'mine' ? ' of your loans' : ' loans on the book')
      : 'no loans');

    if (!STATE.loans.length) {
      var mineOnly = STATE.scope === 'mine';
      body.innerHTML = '<tr><td colspan="9"><div class="empty"><p class="empty-title">' +
        (mineOnly ? 'This account has not opened a loan yet.' : 'No loans have been requested.') + '</p>' +
        '<p class="empty-body">' + (mineOnly
          ? 'Request one above: post collateral of at least 100% of the principal and the pool pays out immediately when it has free liquidity.'
          : 'Switch to My loans to see your own positions, or request a loan above.') + '</p></div></td></tr>';
      return;
    }

    var now = isDemo() ? BigInt(DEMO.chainTime()) : BigInt(Math.floor(Date.now() / 1000));
    var rows = STATE.loans.map(function (loan) {
      var status = Number(loan.status);
      var overdue = isOverdue(loan);
      var actions = loanActions(loan);
      var actionHtml = actions.length
        ? actions.map(function (a) {
          if (!a.enabled) {
            return '<button type="button" class="btn btn-row" disabled title="' + UI.escapeAttr(a.reason) + '">' +
              UI.escapeHtml(a.label) + '</button>';
          }
          return '<button type="button" class="btn btn-row' + (a.primary ? ' btn-primary' : '') + (a.danger ? ' btn-danger' : '') +
            '" data-action="' + UI.escapeAttr(a.action) + '" data-loan-id="' + UI.escapeAttr(loan.id.toString()) + '">' +
            UI.escapeHtml(a.label) + '</button>';
        }).join('')
        : '<span class="cell-sub">no action available</span>';

      var dueCell, owedCell;
      if (status === 2) {
        var due = loan.amountDue !== undefined && loan.amountDue !== null ? BigInt(loan.amountDue) : null;
        var estimated = false;
        if (due === null) {
          /* No live quote available (chain-mode API without a preview): fall back
             to principal + frozen interest and say so rather than implying it is
             the live figure. */
          due = BigInt(loan.principal) + BigInt(loan.interest);
          estimated = true;
        }
        dueCell = UI.escapeHtml(UI.formatDateShort(loan.dueDate)) +
          '<span class="cell-sub"' + (overdue ? ' data-tone="bad"' : '') + '>' +
          UI.escapeHtml(UI.formatRelativeTo(loan.dueDate, now)) + '</span>';
        owedCell = '<span title="' + UI.escapeAttr(UI.amountTitle(due)) + '">' +
          UI.escapeHtml(UI.formatEth(due)) + '</span>' +
          (loan.lateFee && BigInt(loan.lateFee) > 0n
            ? '<span class="cell-sub" data-tone="bad">includes late fee ' + UI.escapeHtml(UI.formatEth(loan.lateFee)) + '</span>'
            : (estimated ? '<span class="cell-sub">principal + interest</span>'
              : (loan.interest ? '<span class="cell-sub">at maturity ' + UI.escapeHtml(UI.formatEth(BigInt(loan.principal) + BigInt(loan.interest))) + '</span>' : '')));
      } else if (status === 1) {
        var remaining = loan.remainingToFund !== undefined && loan.remainingToFund !== null
          ? BigInt(loan.remainingToFund) : BigInt(loan.principal) - BigInt(loan.amountFunded || 0);
        dueCell = '<span class="cell-sub">starts on funding</span>';
        owedCell = UI.escapeHtml(UI.formatEth(remaining)) + '<span class="cell-sub">still to fund</span>';
      } else {
        dueCell = '<span class="cell-sub">' + UI.escapeHtml(status === 3 ? 'settled' : status === 4 ? 'seized' : 'cancelled') + '</span>';
        owedCell = '<span class="cell-sub">—</span>';
      }

      var collateralRatio = '';
      if (status === 2 && loan.collateralRatioBps !== undefined && loan.collateralRatioBps !== null) {
        collateralRatio = '<span class="cell-sub"' + (BigInt(loan.collateralRatioBps) < 10500n ? ' data-tone="warn"' : '') +
          '>' + UI.escapeHtml(UI.formatBps(loan.collateralRatioBps, 0)) + ' cover</span>';
      }

      return '<tr data-loan-row="' + UI.escapeAttr(loan.id.toString()) + '">' +
        '<td class="col-id"><span class="loan-id">#' + UI.escapeHtml(loan.id.toString()) + '</span>' +
          (loan.borrowerLabel ? '<small>' + UI.escapeHtml(loan.borrowerLabel) + '</small>'
            : (loan.borrower ? '<small>' + UI.escapeHtml(UI.shortenAddress(loan.borrower)) + '</small>' : '')) + '</td>' +
        '<td class="col-status"><span class="pill" data-status="' + status + '"' + (overdue ? ' data-overdue="true"' : '') + '>' +
          UI.escapeHtml(overdue && status === 2 ? 'Overdue' : (STATUS_LABEL[status] || 'Unknown')) + '</span></td>' +
        '<td class="num"><span title="' + UI.escapeAttr(UI.amountTitle(loan.principal)) + '">' +
          UI.escapeHtml(UI.formatEth(loan.principal)) + '</span>' +
          (status === 1 && BigInt(loan.amountFunded || 0) > 0n
            ? '<span class="cell-sub">funded ' + UI.escapeHtml(UI.formatEth(loan.amountFunded)) + '</span>' : '') + '</td>' +
        '<td class="num"><span title="' + UI.escapeAttr(UI.amountTitle(loan.collateral)) + '">' +
          UI.escapeHtml(UI.formatEth(loan.collateral)) + '</span>' + collateralRatio + '</td>' +
        '<td class="num col-rate">' + UI.escapeHtml(UI.formatBps(loan.rateBps)) + '</td>' +
        '<td class="num col-term">' + UI.escapeHtml(UI.formatDuration(loan.durationDays)) + '</td>' +
        '<td class="num">' + dueCell + '</td>' +
        '<td class="num">' + owedCell + '</td>' +
        '<td class="col-actions">' + actionHtml + '</td>' +
        '</tr>';
    });

    body.innerHTML = rows.join('');
  }

  /* ------------------------------------------------------------------ *
   * Rendering — position, audit, history
   * ------------------------------------------------------------------ */

  function renderPosition() {
    var position = STATE.position;
    if (!position) {
      ['shares', 'shareValue', 'collateralLocked', 'outstandingDebt', 'loanCounts', 'net', 'balance']
        .forEach(function (key) { fill('[data-position="' + key + '"]', '—'); });
      return;
    }
    fill('[data-position="shares"]', UI.formatEth(position.shares) + ' units', UI.amountTitle(position.shares, 'share units'));
    fill('[data-position="shareValue"]', UI.formatEth(position.shareValue) + ' ETH', UI.amountTitle(position.shareValue));
    fill('[data-position="collateralLocked"]', UI.formatEth(position.collateralLocked) + ' ETH', UI.amountTitle(position.collateralLocked));
    fill('[data-position="outstandingDebt"]', UI.formatEth(position.outstandingDebt) + ' ETH', UI.amountTitle(position.outstandingDebt));
    fill('[data-position="loanCounts"]', String(position.activeLoans) + ' active / ' + String(position.pendingLoans) + ' pending');
    var net = position.shareValue + position.collateralLocked + position.ethBalance - position.outstandingDebt;
    var netNode = one('[data-position="net"]');
    if (netNode) {
      UI.setText(netNode, UI.formatEth(net, { dp: 4, signed: true }) + ' ETH');
      netNode.setAttribute('title', UI.amountTitle(net) + ' = share value + collateral locked + wallet balance − debt outstanding');
    }
    fill('[data-position="balance"]', UI.formatEth(position.ethBalance) + ' ETH', UI.amountTitle(position.ethBalance));
  }

  function renderAudit() {
    var demoAudit = STATE.audit;
    var node = one('[data-audit="body"]');
    var footerNode = one('[data-audit="footer"]');
    var wrap = one('#ledger-audit');
    var footerWrap = one('#audit-footer');

    if (!demoAudit) {
      if (wrap) wrap.setAttribute('hidden', '');
      if (footerWrap) footerWrap.setAttribute('hidden', '');
      return;
    }
    var diff = demoAudit.difference;
    var tone = demoAudit.balanced ? 'ok' : 'bad';
    var text = demoAudit.balanced
      ? 'balanced: the ' + UI.formatEth(demoAudit.cashHeld) + ' ETH held equals free liquidity plus collateral held plus unclaimed fees.'
      : 'free liquidity + collateral held + unclaimed fees = ' + UI.formatEth(demoAudit.claims) +
        ' ETH, but the pool holds ' + UI.formatEth(demoAudit.cashHeld) + ' ETH (' +
        UI.formatEth(diff, { dp: 6, signed: true }) + ' ETH).';
    var tooltip = 'Every supply, loan, repayment and liquidation must leave this at zero: ' +
      'cash held = (totalLiquidity − reservedLiquidity) + accumulatedCollateral + treasuryBalance. ' +
      'The demo tracks the pool cash independently, so a non-zero difference means the mirrored arithmetic has drifted.';
    [node, footerNode].forEach(function (el) {
      if (!el) return;
      el.textContent = text;
      el.setAttribute('data-tone', tone);
      el.setAttribute('title', tooltip);
    });
    if (wrap) wrap.removeAttribute('hidden');
    if (footerWrap) footerWrap.removeAttribute('hidden');
  }

  var TYPE_LABEL = {
    /* demo ledger types */
    deposit: 'Supplied', withdraw: 'Withdrew', request: 'Loan requested', fund: 'Funded loan',
    repay: 'Repaid loan', liquidate: 'Liquidated loan', cancel: 'Cancelled loan',
    clock: 'Ledger clock', setParams: 'Parameters changed', setPaused: 'Pause toggled',
    setTreasury: 'Treasury changed', transferOwnership: 'Ownership transferred',
    claimTreasury: 'Fees claimed', notice: 'Notice',
    /* backend EVENT_TO_TX_TYPE values (backend/app.py) */
    loan_request: 'Loan requested', loan_fund: 'Funded loan', loan_repay: 'Repaid loan',
    loan_liquidate: 'Liquidated loan', loan_cancel: 'Cancelled loan',
    treasury_claim: 'Fees claimed', params_update: 'Parameters changed', paused_set: 'Pause toggled',
    treasury_set: 'Treasury changed', ownership_transfer: 'Ownership transferred',
    initialize: 'Pool initialised',
    tx: 'Transaction'
  };

  function historyTypeGroup(type) {
    var t = String(type || '').toLowerCase();
    if (t === 'loan_request' || t === 'loan_created' || t === 'request') return 'request';
    if (t === 'loan_fund' || t === 'loan_funded' || t === 'fund') return 'fund';
    if (t === 'loan_repay' || t === 'loan_repaid' || t === 'repay') return 'repay';
    if (t === 'loan_liquidate' || t === 'loan_liquidated' || t === 'liquidate') return 'liquidate';
    if (t === 'loan_cancel' || t === 'loan_cancelled' || t === 'cancel') return 'cancel';
    if (['treasury_claim', 'params_update', 'paused_set', 'treasury_set', 'ownership_transfer', 'initialize',
      'setparams', 'setpaused', 'settreasury', 'transferownership', 'claimtreasury'].indexOf(t) !== -1) return 'admin';
    return t;
  }

  function renderHistory() {
    var body = one('#history-body');
    if (!body) return;
    var rows = STATE.history.slice();
    if (STATE.historyType) {
      rows = rows.filter(function (row) { return historyTypeGroup(row.type) === STATE.historyType; });
    }
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="5"><div class="empty"><p class="empty-title">No records yet.</p>' +
        '<p class="empty-body">Supplies, loans, repayments and liquidations appear here as they happen' +
        (isDemo() ? ', with the simulated clock marked so you can see what moved time forward.' : '.') + '</p></div></td></tr>';
      return;
    }
    body.innerHTML = rows.slice(0, 120).map(function (row) {
      var amount = UI.toWeiBig(row.amountWei || 0);
      var amountText = amount === 0n ? '—' : UI.formatEth(amount) + ' ETH';
      var group = UI.escapeHtml(TYPE_LABEL[String(row.type).toLowerCase()] || (TYPE_LABEL[historyTypeGroup(row.type)] || row.type));
      var reference;
      if (isDemo() || row.demo) {
        reference = '<span class="demo-tag">DEMO DATA</span><span class="tx-ref"> ' +
          UI.escapeHtml(row.hash ? UI.formatTxHash(row.hash) : 'local record') + '</span>';
      } else {
        var url = exploreUrl(row.hash);
        reference = url
          ? '<a href="' + UI.escapeAttr(url) + '" target="_blank" rel="noopener noreferrer" class="tx-ref">' +
            UI.escapeHtml(UI.formatTxHash(row.hash)) + '</a>'
          : '<span class="tx-ref">' + UI.escapeHtml(row.hash ? UI.formatTxHash(row.hash) : 'local record') + '</span>';
      }
      return '<tr>' +
        '<td class="col-time">' + UI.escapeHtml(UI.formatTimestamp(row.timestamp)) + '</td>' +
        '<td class="col-event">' + group + (row.loanId !== null && row.loanId !== undefined ? '<span class="cell-sub">loan #' + UI.escapeHtml(String(row.loanId)) + '</span>' : '') + '</td>' +
        '<td class="num"><span title="' + UI.escapeAttr(UI.amountTitle(amount)) + '">' + UI.escapeHtml(amountText) + '</span></td>' +
        '<td class="col-detail">' + UI.escapeHtml(row.note || (row.from ? UI.shortenAddress(row.from) : '—')) + '</td>' +
        '<td class="col-tx">' + reference + '</td>' +
        '</tr>';
    }).join('');
  }

  /* ------------------------------------------------------------------ *
   * Rendering — admin panel
   * ------------------------------------------------------------------ */

  function renderAdmin() {
    var form = one('#form-params');
    var lock = one('#admin-lock');
    if (!form || !lock) return;
    var address = currentAddress();
    var owner = STATE.owner;
    var isOwner = !!(address && owner && String(address).toLowerCase() === String(owner).toLowerCase());
    var params = STATE.params;

    Array.prototype.forEach.call(form.querySelectorAll('input, button'), function (el) {
      el.disabled = !isOwner;
    });
    fill('[data-panel-meta="admin"]', owner ? 'owner ' + UI.shortenAddress(owner) : 'owner unknown');

    if (isOwner) {
      lock.setAttribute('data-state', 'owner');
      lock.textContent = isDemo()
        ? 'You are the pool owner in this demo ledger, so every control below works against the local book. In chain mode the same calls go through setParams / setPaused / setTreasury / claimTreasury on the contract.'
        : 'Connected as the pool owner (' + owner + '). These calls go straight to the contract.';
    } else {
      lock.setAttribute('data-state', 'locked');
      lock.textContent = owner
        ? 'Owner-only. The owner is ' + owner + '; controls are disabled for ' + (address || 'this session') + '.'
        : 'Owner-only. Connect a wallet to see whether this account holds the owner role.';
    }

    if (params) {
      var set = function (id, value) {
        var node = one('#' + id);
        if (node && DOC.activeElement !== node) node.value = value.toString();
      };
      set('p-fee', params.feeBps);
      set('p-penalty', params.penaltyBps);
      set('p-late', params.lateFeeBps);
      set('p-collateral', params.minCollateralBps);
      set('p-maxrate', params.maxRateBps);
      set('p-maxduration', params.maxDurationDays);
      set('p-minloan', params.minLoanPrincipal);
      set('p-maxloan', params.maxLoanPrincipal);
      set('p-mindeposit', params.minDeposit);
    }
    var pause = one('#pause-toggle');
    if (pause) {
      UI.setText(pause, STATE.stats && STATE.stats.paused ? 'Unpause pool' : 'Pause pool');
      pause.setAttribute('title', STATE.stats && STATE.stats.paused
        ? 'Withdrawals and repayments already work while paused; unpausing re-enables deposits and new loans.'
        : 'Blocks deposits, funding and new loan requests. Withdrawals and repayments keep working.');
    }
    var claim = one('#claim-treasury');
    if (claim && STATE.stats) {
      claim.setAttribute('title', 'Treasury holds ' + UI.formatEth(STATE.stats.treasuryBalance) + ' ETH of protocol fees.');
    }
    Array.prototype.forEach.call(form.querySelectorAll('button'), function (el) {
      el.setAttribute('aria-disabled', el.disabled ? 'true' : 'false');
    });
  }

  function renderSettings() {
    var contract = one('#s-contract');
    var api = one('#s-api');
    if (contract && DOC.activeElement !== contract) contract.value = CFG.contractAddress || '';
    if (api && DOC.activeElement !== api) api.value = CFG.apiBase || '';
    fill('[data-panel-meta="settings"]', (isDemo() ? 'demo mode' : 'chain mode') +
      (STATE.remote ? ', backend reachable' : (STATE.backendOnline === false ? ', backend offline' : '')));
  }

  /* ------------------------------------------------------------------ *
   * Full render
   * ------------------------------------------------------------------ */

  function render() {
    renderTopbar();
    renderBanner();
    renderRuntimeNote();
    renderHero();
    renderKpis();
    renderSupplyPanel();
    renderBorrowPanel();
    renderLoans();
    renderPosition();
    renderAudit();
    renderHistory();
    renderAdmin();
    renderSettings();
    renderFooter();
  }

  /* ------------------------------------------------------------------ *
   * Refresh
   * ------------------------------------------------------------------ */

  function refresh(opts) {
    var o = opts || {};
    var tasks;
    if (isDemo()) {
      DEMO.ensure();
      tasks = [loadPool(), loadPosition(), loadLoans(), loadHistory()];
    } else {
      tasks = [
        loadPool().catch(function (err) {
          if (!o.silent) UI.toast(err.message, { kind: 'error', title: 'Pool read failed' });
          return null;
        }),
        loadPosition(),
        loadLoans(),
        loadHistory()
      ];
    }
    return Promise.all(tasks).then(function () {
      render();
    }, function (err) {
      render();
      if (!o.silent) UI.toast(err && err.message ? err.message : 'The dashboard could not be refreshed.', { kind: 'error' });
    });
  }

  /* ------------------------------------------------------------------ *
   * Write plumbing
   * ------------------------------------------------------------------ */

  function reportError(err, title) {
    var message = err && (err.userMessage || err.message) ? (err.userMessage || err.message) : 'The action failed.';
    UI.toast(message, { kind: 'error', title: title || 'Not completed' });
    if (global.console && global.console.warn) global.console.warn('[MicroLend]', err);
  }

  /* Runs a write, shows the confirm dialog, and refreshes afterwards.
     `exec` returns either a demo result or {hash, wait, explorerUrl}. */
  function perform(opts) {
    var o = opts;
    busyInc();
    var button = o.button ? one(o.button) : null;
    if (button) UI.setBusy(button, true, o.busyLabel || 'Working');
    var started = Date.now();
    return Promise.resolve()
      .then(function () { return o.exec(); })
      .then(function (result) {
        var settle = Math.max(0, 260 - (Date.now() - started));
        return sleep(settle).then(function () { return result; });
      })
      .then(function (result) {
        if (result && result.hash && !isDemo()) {
          pushLocalHistory({
            timestamp: Math.floor(Date.now() / 1000),
            type: o.historyType || 'tx',
            status: 'submitted',
            from: currentAddress() || '',
            to: '',
            amountWei: String(o.amountWei || 0),
            loanId: o.loanId === undefined ? null : String(o.loanId),
            hash: result.hash,
            note: o.successNote || '',
            demo: false
          });
          UI.toast(o.pendingMessage || 'Transaction submitted. Waiting for confirmation.', {
            kind: 'info', title: 'Submitted', explorerUrl: result.explorerUrl
          });
          return result.wait().then(function () {
            if (STATE.backendOnline && API.hasSession()) {
              API.syncTransaction(result.hash).catch(function () { /* the indexer will catch up later */ });
            }
            return result;
          }, function (err) {
            throw new Error(contractRejectionReason(err));
          });
        }
        return result;
      })
      .then(function (result) {
        var detail = o.describe ? o.describe(result) : '';
        UI.toast(o.successMessage || 'Done.', {
          kind: 'success',
          title: o.successTitle || 'Done',
          detail: detail,
          explorerUrl: result && result.hash ? exploreUrl(result.hash) : ''
        });
        if (result && result.hash && !isDemo()) {
          pushLocalHistory({
            timestamp: Math.floor(Date.now() / 1000),
            type: o.historyType || 'tx',
            status: 'confirmed',
            from: currentAddress() || '',
            to: '',
            amountWei: String(o.amountWei || 0),
            loanId: o.loanId === undefined ? null : String(o.loanId),
            hash: result.hash,
            note: o.successNote || '',
            demo: false
          });
        }
        return refresh({ silent: true }).then(function () { return result; });
      })
      .catch(function (err) {
        reportError(err, o.errorTitle);
        throw err;
      })
      .finally(function () {
        busyDec();
        if (button) UI.setBusy(button, false);
      });
  }

  function contractRejectionReason(err) {
    if (err && (err.code === 4001 || err.code === 'ACTION_REJECTED')) {
      return 'The transaction was rejected in the wallet.';
    }
    if (err && err.receipt && err.receipt.status === 0) {
      return 'The transaction was mined but reverted. Nothing changed on the pool.';
    }
    return (err && (err.shortMessage || err.message)) || 'The transaction did not confirm.';
  }

  function confirmWrite(opts) {
    return UI.confirmDialog(opts);
  }

  /* ------------------------------------------------------------------ *
   * Actions
   * ------------------------------------------------------------------ */

  function actionDeposit() {
    var raw = one('#supply-amount').value;
    var parsed = UI.parseEthToWei(raw);
    if (!parsed.ok) { setError('supply', parsed.reason); return Promise.resolve(); }
    setError('supply', '');
    var stats = STATE.stats;
    if (!stats) { setError('supply', 'The pool totals have not loaded yet. Try again in a moment.'); return Promise.resolve(); }
    var min = STATE.params ? STATE.params.minDeposit : 0n;
    if (parsed.wei < min) { setError('supply', 'The minimum supply is ' + UI.formatEth(min) + ' ETH.'); return Promise.resolve(); }
    if (stats && stats.paused) { setError('supply', 'The pool is paused: deposits are blocked until the owner unpauses it.'); return Promise.resolve(); }

    var shares = stats.totalShares === 0n
      ? (parsed.wei > 1n ? parsed.wei - 1n : 0n)
      : (stats.totalLiquidity === 0n ? parsed.wei : (parsed.wei * stats.totalShares) / stats.totalLiquidity);

    return confirmWrite({
      kicker: 'Supply',
      title: 'Supply ' + UI.formatEth(parsed.wei) + ' ETH to the pool',
      body: 'The pool mints share units at the current share price. Shares appreciate as borrowers repay interest, and can be withdrawn whenever free liquidity allows.',
      rows: [
        ['Supplying', UI.formatEth(parsed.wei) + ' ETH'],
        ['Share units received', UI.formatEth(shares) + ' (share price ' + UI.formatEth(stats ? stats.sharePrice : 10n ** 18n, { dp: 6 }) + ' ETH)'],
        ['Pool after this', UI.formatEth((stats ? stats.totalLiquidity : 0n) + parsed.wei) + ' ETH supplied'],
        ['Source of funds', isDemo()
          ? currentAddress() + ' (simulated demo balance)'
          : 'Your wallet, signed by ' + (WALLET.address() || 'the connected account')]
      ],
      confirmLabel: 'Supply ETH'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#supply-submit',
        busyLabel: 'Supplying',
        historyType: 'deposit',
        amountWei: parsed.wei.toString(),
        successTitle: 'Supplied',
        successMessage: 'Supplied ' + UI.formatEth(parsed.wei) + ' ETH to the pool.',
        describe: function (result) {
          return result && result.minted ? 'Received ' + UI.formatEth(result.minted) + ' share units.' : '';
        },
        errorTitle: 'Supply failed',
        exec: function () {
          if (isDemo()) return DEMO.deposit(currentAddress(), parsed.wei.toString());
          return CONTRACT.WRITE.deposit(UI.formatEthExact(parsed.wei));
        }
      }).then(function () {
        var input = one('#supply-amount');
        if (input) input.value = '';
        renderSupplyReceipt();
      });
    }).catch(function () { /* already reported */ });
  }

  function actionWithdraw() {
    var raw = one('#supply-amount').value;
    var parsed = UI.parseInteger(raw);
    if (!parsed.ok) { setError('supply', 'Enter the number of share units to burn. ' + parsed.reason); return Promise.resolve(); }
    setError('supply', '');
    var stats = STATE.stats;
    var position = STATE.position;
    if (position && parsed.value > position.shares) {
      setError('supply', 'You hold ' + UI.formatEth(position.shares) + ' share units.');
      return Promise.resolve();
    }
    var assets = stats && stats.totalShares > 0n ? (parsed.value * stats.totalLiquidity) / stats.totalShares : 0n;
    if (assets === 0n) { setError('supply', 'Those share units redeem to zero ETH.'); return Promise.resolve(); }
    if (stats && assets > stats.availableLiquidity) {
      setError('supply', 'Only ' + UI.formatEth(stats.availableLiquidity) +
        ' ETH is free to withdraw. The rest is reserved for active loans; repay or liquidate them first.');
      return Promise.resolve();
    }

    return confirmWrite({
      kicker: 'Withdraw',
      title: 'Burn ' + UI.formatEth(parsed.value) + ' share units for ' + UI.formatEth(assets) + ' ETH',
      body: 'Liquidity reserved for active loans cannot be withdrawn. This request fits inside the pool\'s free liquidity today.',
      rows: [
        ['Share units burned', UI.formatEth(parsed.value)],
        ['ETH returned', UI.formatEth(assets)],
        ['Free liquidity after', UI.formatEth(stats.availableLiquidity - assets) + ' ETH'],
        ['Price per unit', UI.formatEth(stats.sharePrice, { dp: 6 }) + ' ETH']
      ],
      confirmLabel: 'Withdraw ETH'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#supply-submit',
        busyLabel: 'Withdrawing',
        historyType: 'withdraw',
        amountWei: assets.toString(),
        successTitle: 'Withdrawn',
        successMessage: 'Burned ' + UI.formatEth(parsed.value) + ' share units for ' + UI.formatEth(assets) + ' ETH.',
        errorTitle: 'Withdrawal failed',
        exec: function () {
          if (isDemo()) return DEMO.withdraw(currentAddress(), parsed.value.toString());
          return CONTRACT.WRITE.withdraw(parsed.value);
        }
      }).then(function () {
        var input = one('#supply-amount');
        if (input) input.value = '';
        renderSupplyReceipt();
      });
    }).catch(function () { /* already reported */ });
  }

  function borrowValidation() {
    var params = STATE.params;
    var input = borrowInput();
    var errors = [];
    if (!input.principal.ok) errors.push(['principal', input.principal.reason]);
    if (!input.rate.ok) errors.push(['rate', input.rate.reason]);
    if (!input.duration.ok) errors.push(['duration', input.duration.reason]);
    if (!input.collateral.ok) errors.push(['collateral', input.collateral.reason]);
    if (errors.length) return { ok: false, field: errors[0][0], reason: errors[0][1], input: input };
    if (input.principal.wei < params.minLoanPrincipal) {
      return { ok: false, field: 'principal', reason: 'Principal is below the minimum of ' + UI.formatEth(params.minLoanPrincipal) + ' ETH.', input: input };
    }
    if (input.principal.wei > params.maxLoanPrincipal) {
      return { ok: false, field: 'principal', reason: 'Principal is above the maximum of ' + UI.formatEth(params.maxLoanPrincipal) + ' ETH.', input: input };
    }
    if (input.duration.value === 0n || input.duration.value > params.maxDurationDays) {
      return { ok: false, field: 'duration', reason: 'The term must be between 1 and ' + params.maxDurationDays.toString() + ' days.', input: input };
    }
    if (input.rate.bps > params.maxRateBps) {
      return { ok: false, field: 'rate', reason: 'The rate ceiling is ' + UI.formatBps(params.maxRateBps) + ' APR.', input: input };
    }
    var quote = isDemo()
      ? DEMO.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value)
      : CONTRACT.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value, params.minCollateralBps);
    if (input.collateral.wei < quote.requiredCollateral) {
      return {
        ok: false, field: 'collateral',
        reason: 'Collateral must be at least ' + UI.formatEth(quote.requiredCollateral) + ' ETH (' + UI.formatBps(params.minCollateralBps) + ' of principal).',
        input: input, quote: quote
      };
    }
    return { ok: true, input: input, quote: quote };
  }

  function actionBorrow() {
    var check = borrowValidation();
    if (!check.ok) {
      setError('borrow', check.reason);
      setHint(check.field, check.reason, 'bad');
      return Promise.resolve();
    }
    setError('borrow', '');
    var input = check.input;
    var quote = check.quote;
    var interest = quote.totalDue - input.principal.wei;
    var params = STATE.params;
    var fee = (interest * params.feeBps) / 10000n;
    var stats = STATE.stats;
    var activates = input.principal.wei <= stats.availableLiquidity;
    var nowSeconds = isDemo() ? BigInt(DEMO.chainTime()) : BigInt(Math.floor(Date.now() / 1000));
    var dueSeconds = nowSeconds + input.duration.value * 86400n;

    return confirmWrite({
      kicker: 'Request loan',
      title: 'Borrow ' + UI.formatEth(input.principal.wei) + ' ETH for ' + input.duration.value.toString() + ' days',
      body: activates
        ? 'The pool holds enough free liquidity, so this loan activates in the same transaction and the principal is paid to your wallet immediately.'
        : 'The pool does not hold enough free liquidity, so this request will wait in Pending until it is fully funded or cancelled.',
      rows: [
        ['Principal', UI.formatEth(input.principal.wei) + ' ETH'],
        ['Interest for the term', UI.formatEth(interest) + ' ETH at ' + UI.formatBps(input.rate.bps) + ' APR'],
        ['Repay at maturity', UI.formatEth(quote.totalDue) + ' ETH'],
        ['Collateral locked', UI.formatEth(input.collateral.wei) + ' ETH'],
        ['Protocol fee on interest', UI.formatEth(fee) + ' ETH'],
        ['Due date', UI.formatTimestamp(dueSeconds)],
        ['Outcome', activates ? 'Activates immediately, principal paid out now' : 'Stays Pending until funded']
      ],
      warning: isDemo() ? '' : 'Collateral stays in the pool contract. If the loan is not repaid by the due date, anyone can liquidate it.',
      confirmLabel: activates ? 'Request and activate' : 'Request loan'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#borrow-submit',
        busyLabel: 'Requesting',
        historyType: 'request',
        amountWei: input.principal.wei.toString(),
        successTitle: 'Loan requested',
        successMessage: 'Loan for ' + UI.formatEth(input.principal.wei) + ' ETH at ' + UI.formatBps(input.rate.bps) + ' APR.',
        describe: function (result) {
          if (result && result.loanId !== undefined && result.loanId !== null) {
            return 'Loan #' + result.loanId + ' — ' + (Number(result.status) === 2 ? 'active and paid out.' : 'pending funding.');
          }
          return activates ? 'The loan is active and the principal has been paid out.' : 'The loan is pending until it is funded.';
        },
        errorTitle: 'Loan request failed',
        exec: function () {
          if (isDemo()) {
            var requested = DEMO.requestLoan(currentAddress(), {
              principal: input.principal.wei.toString(),
              rateBps: input.rate.bps.toString(),
              durationDays: input.duration.value.toString(),
              collateral: input.collateral.wei.toString()
            });
            return { loanId: requested.loanId, status: requested.status, hash: requested.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.requestLoan({
            principal: input.principal.wei,
            rateBps: input.rate.bps,
            durationDays: input.duration.value,
            collateral: input.collateral.wei
          });
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionFund(loanId) {
    var loan = findLoan(loanId);
    if (!loan) return Promise.resolve();
    var remaining = loan.remainingToFund !== undefined && loan.remainingToFund !== null
      ? BigInt(loan.remainingToFund) : BigInt(loan.principal) - BigInt(loan.amountFunded || 0);
    if (remaining <= 0n) { UI.toast('That loan is already fully funded.', { kind: 'warn' }); return Promise.resolve(); }

    return confirmWrite({
      kicker: 'Fund loan #' + loanId,
      title: 'Fund the remaining ' + UI.formatEth(remaining) + ' ETH',
      body: 'Funding joins the pool exactly like a supply: you receive share units for the contribution, and the loan activates the moment it is fully funded, paying the borrower immediately.',
      rows: [
        ['Loan', '#' + loanId + ' for ' + UI.formatEth(loan.principal) + ' ETH'],
        ['Already funded', UI.formatEth(loan.amountFunded || 0n) + ' ETH'],
        ['You contribute', UI.formatEth(remaining) + ' ETH'],
        ['Share units received', STATE.stats && STATE.stats.totalLiquidity > 0n
          ? UI.formatEth((remaining * STATE.stats.totalShares) / STATE.stats.totalLiquidity)
          : UI.formatEth(remaining)]
      ],
      confirmLabel: 'Fund loan'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        historyType: 'fund',
        loanId: loanId,
        amountWei: remaining.toString(),
        successTitle: 'Loan funded',
        successMessage: 'Funded loan #' + loanId + ' with ' + UI.formatEth(remaining) + ' ETH.',
        errorTitle: 'Funding failed',
        exec: function () {
          if (isDemo()) {
            /* ML_DEMO is synchronous (it mirrors the contract's integer maths with
               no I/O), so its result is mapped here rather than chained. */
            var funded = DEMO.fundLoan(currentAddress(), loanId, remaining.toString());
            return { hash: funded.tx.hash, demo: true, status: funded.status, shares: funded.shares };
          }
          return CONTRACT.WRITE.fundLoan(loanId, UI.formatEthExact(remaining));
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionRepay(loanId) {
    var loan = findLoan(loanId);
    if (!loan) return Promise.resolve();
    var due = loan.amountDue !== undefined && loan.amountDue !== null ? BigInt(loan.amountDue) : null;
    if (due === null) {
      due = isDemo() ? DEMO.previewRepayment(loanId).amountDue
        : BigInt(loan.principal) + BigInt(loan.interest);
    }
    var interest = BigInt(loan.interest || 0);
    var params = STATE.params;
    var fee = (interest * params.feeBps) / 10000n;
    var lateFee = loan.lateFee !== undefined && loan.lateFee !== null ? BigInt(loan.lateFee) : 0n;
    var payerBalance = STATE.position ? BigInt(STATE.position.ethBalance) : null;

    return confirmWrite({
      kicker: loan.overdue || isOverdue(loan) ? 'Repay a late loan' : 'Repay loan #' + loanId,
      title: 'Repay ' + UI.formatEth(due) + ' ETH',
      body: 'Repayment returns the full collateral to the borrower and credits the interest to the pool, so every share unit becomes worth slightly more.',
      rows: [
        ['Principal', UI.formatEth(loan.principal) + ' ETH'],
        ['Interest', UI.formatEth(interest) + ' ETH'],
        ['Late fee', lateFee > 0n ? UI.formatEth(lateFee) + ' ETH (1% per started 30 days)' : 'none'],
        ['Total due', UI.formatEth(due) + ' ETH'],
        ['Protocol fee', UI.formatEth(fee) + ' ETH to the treasury'],
        ['Collateral returned', UI.formatEth(loan.collateral) + ' ETH']
      ],
      warning: isDemo() && payerBalance !== null && payerBalance < due
        ? 'The demo account ' + currentAddress() + ' holds only ' + UI.formatEth(payerBalance) +
          ' ETH against the ' + UI.formatEth(due) + ' ETH due. Switch the acting account, restore the sample book, ' +
          'or reset the ledger to replenish the simulated balances.'
        : '',
      confirmLabel: 'Repay ' + UI.formatEth(due) + ' ETH'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        historyType: 'repay',
        loanId: loanId,
        amountWei: due.toString(),
        successTitle: 'Loan repaid',
        successMessage: 'Repaid ' + UI.formatEth(due) + ' ETH; collateral ' + UI.formatEth(loan.collateral) + ' ETH returned.',
        errorTitle: 'Repayment failed',
        exec: function () {
          if (isDemo()) {
            var repaid = DEMO.repayLoan(currentAddress(), loanId, due.toString());
            return { hash: repaid.tx.hash, demo: true, lateFee: repaid.lateFee, fee: repaid.fee, refund: repaid.refund };
          }
          return CONTRACT.WRITE.repayLoan(loanId, UI.formatEthExact(due));
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionCancel(loanId) {
    var loan = findLoan(loanId);
    if (!loan) return Promise.resolve();
    return confirmWrite({
      kicker: 'Cancel loan #' + loanId,
      title: 'Cancel the request and recover ' + UI.formatEth(loan.collateral) + ' ETH',
      body: 'Only an unfunded Pending request can be cancelled, and only by its borrower. The collateral is returned in the same transaction.',
      rows: [
        ['Loan', '#' + loanId],
        ['Funding received', UI.formatEth(loan.amountFunded || 0n) + ' ETH'],
        ['Collateral returned', UI.formatEth(loan.collateral) + ' ETH']
      ],
      confirmLabel: 'Cancel request'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        historyType: 'cancel',
        loanId: loanId,
        amountWei: BigInt(loan.collateral).toString(),
        successTitle: 'Request cancelled',
        successMessage: 'Loan #' + loanId + ' cancelled; collateral returned.',
        errorTitle: 'Cancellation failed',
        exec: function () {
          if (isDemo()) {
            var cancelled = DEMO.cancelLoan(currentAddress(), loanId);
            return { hash: cancelled.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.cancelLoan(loanId);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionLiquidate(loanId) {
    var loan = findLoan(loanId);
    if (!loan) return Promise.resolve();
    var due = loan.amountDue !== undefined && loan.amountDue !== null ? BigInt(loan.amountDue) : null;
    if (due === null) due = isDemo() ? DEMO.previewRepayment(loanId).amountDue : BigInt(loan.principal) + BigInt(loan.interest);
    var collateral = BigInt(loan.collateral);
    var params = STATE.params;
    var penalty = (due * params.penaltyBps) / 10000n;
    var compensation = due + penalty > collateral ? collateral : due + penalty;
    var refund = collateral - compensation;
    var badDebt = collateral < due ? due - collateral : 0n;

    return confirmWrite({
      kicker: 'Liquidate loan #' + loanId,
      title: 'Seize ' + UI.formatEth(collateral) + ' ETH of collateral',
      body: 'Anyone may liquidate a loan that is past its due date. The pool keeps the debt plus the penalty, capped at the collateral posted; anything left over is refunded to the borrower and only a real shortfall becomes bad debt.',
      rows: [
        ['Debt at today\'s date', UI.formatEth(due) + ' ETH'],
        ['Liquidation penalty', UI.formatEth(penalty) + ' ETH (' + UI.formatBps(params.penaltyBps) + ')'],
        ['Pool receives', UI.formatEth(compensation) + ' ETH'],
        ['Refunded to borrower', UI.formatEth(refund) + ' ETH'],
        ['Bad debt written off', UI.formatEth(badDebt) + ' ETH']
      ],
      warning: badDebt > 0n
        ? 'The collateral does not cover the debt, so ' + UI.formatEth(badDebt) + ' ETH is written off and suppliers absorb the loss.'
        : '',
      danger: true,
      confirmLabel: 'Liquidate'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        historyType: 'liquidate',
        loanId: loanId,
        amountWei: compensation.toString(),
        successTitle: 'Loan liquidated',
        successMessage: 'Loan #' + loanId + ' liquidated. The pool recovered ' + UI.formatEth(compensation) + ' ETH.',
        errorTitle: 'Liquidation failed',
        exec: function () {
          if (isDemo()) {
            var seized = DEMO.liquidate(currentAddress(), loanId);
            return { hash: seized.tx.hash, demo: true, refund: seized.refund, badDebt: seized.badDebt };
          }
          return CONTRACT.WRITE.liquidate(loanId);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function findLoan(loanId) {
    var id = String(loanId);
    for (var i = 0; i < STATE.loans.length; i++) {
      if (String(STATE.loans[i].id) === id) return STATE.loans[i];
    }
    if (isDemo()) return DEMO.getLoan(id) || null;
    return null;
  }

  function actionSetParams() {
    var read = function (id) {
      var node = one('#' + id);
      var parsed = UI.parseInteger(node ? node.value : '');
      return parsed;
    };
    var fields = [
      ['p-fee', 'feeBps'], ['p-penalty', 'penaltyBps'], ['p-late', 'lateFeeBps'],
      ['p-collateral', 'minCollateralBps'], ['p-maxrate', 'maxRateBps'], ['p-maxduration', 'maxDurationDays'],
      ['p-minloan', 'minLoanPrincipal'], ['p-maxloan', 'maxLoanPrincipal'], ['p-mindeposit', 'minDeposit']
    ];
    var next = {};
    var invalid = null;
    fields.forEach(function (pair) {
      var parsed = read(pair[0]);
      if (!parsed.ok && !invalid) invalid = pair[0];
      if (parsed.ok) next[pair[1]] = parsed.value;
    });
    if (invalid) {
      setError('params', 'Every parameter must be a whole number (wei for amounts, bps for rates).');
      return Promise.resolve();
    }
    setError('params', '');
    var params = STATE.params;
    var rows = fields.map(function (pair) {
      var before = params[pair[1]];
      var after = next[pair[1]];
      return [pair[1], String(before) + ' → ' + String(after) + (String(before) === String(after) ? '  (unchanged)' : '')];
    });
    return confirmWrite({
      kicker: 'Protocol admin',
      title: 'Update the protocol parameters',
      body: 'Existing loans keep the rate and interest frozen at request time; the new values apply to loans requested afterwards. Fee, penalty and late fee each cap at 2000 bps.',
      rows: rows,
      confirmLabel: 'Save parameters'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#params-submit',
        busyLabel: 'Saving',
        historyType: 'setParams',
        successTitle: 'Parameters saved',
        successMessage: 'The protocol parameters were updated.',
        errorTitle: 'Parameter update failed',
        exec: function () {
          if (isDemo()) {
            var applied = DEMO.setParams(currentAddress(), next);
            return { hash: applied.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.setParams(next);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionPause() {
    var paused = !!(STATE.stats && STATE.stats.paused);
    return confirmWrite({
      kicker: 'Protocol admin',
      title: paused ? 'Unpause the pool' : 'Pause the pool',
      body: paused
        ? 'Deposits, loan funding and new loan requests become available again.'
        : 'Deposits, loan funding and new loan requests are blocked. Withdrawals and repayments keep working, so nobody is trapped.',
      confirmLabel: paused ? 'Unpause' : 'Pause'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#pause-toggle',
        historyType: 'setPaused',
        successTitle: paused ? 'Pool unpaused' : 'Pool paused',
        successMessage: paused ? 'Deposits and new loans are allowed again.' : 'Deposits, funding and new loans are blocked.',
        errorTitle: 'Could not change the pause state',
        exec: function () {
          if (isDemo()) {
            var toggled = DEMO.setPaused(currentAddress(), !paused);
            return { hash: toggled.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.setPaused(!paused);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionClaimTreasury() {
    var to = currentAddress();
    var amount = STATE.stats ? STATE.stats.treasuryBalance : 0n;
    return confirmWrite({
      kicker: 'Protocol admin',
      title: 'Claim ' + UI.formatEth(amount) + ' ETH of protocol fees',
      body: 'Unclaimed fees leave the pool and are sent to the owner\'s address. Only what free liquidity allows can be claimed at once.',
      rows: [
        ['Treasury balance', UI.formatEth(amount) + ' ETH'],
        ['Sent to', to || '—'],
        ['Free liquidity', UI.formatEth(STATE.stats ? STATE.stats.availableLiquidity : 0n) + ' ETH']
      ],
      confirmLabel: 'Claim fees'
    }).then(function (ok) {
      if (!ok) return null;
      return perform({
        button: '#claim-treasury',
        historyType: 'claimTreasury',
        amountWei: amount.toString(),
        successTitle: 'Fees claimed',
        successMessage: 'Protocol fees were transferred to ' + (to ? UI.shortenAddress(to) : 'the owner') + '.',
        errorTitle: 'Claim failed',
        exec: function () {
          if (isDemo()) {
            var claimed = DEMO.claimTreasury(currentAddress(), to);
            return { hash: claimed.tx.hash, demo: true, amount: claimed.amount };
          }
          return CONTRACT.WRITE.claimTreasury(to);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionSetTreasury() {
    return confirmWrite({
      kicker: 'Protocol admin',
      title: 'Set the treasury address',
      body: 'The treasury receives the protocol fee on interest. It has no other access to pool funds.',
      input: { label: 'Treasury address', placeholder: '0x…', value: STATE.treasury || '', hint: 'Any valid 20-byte hex address.' },
      confirmLabel: 'Set treasury'
    }).then(function (address) {
      if (!address) return null;
      if (!UI.isHexAddress(address)) {
        UI.toast('That is not a valid 20-byte hex address.', { kind: 'error' });
        return null;
      }
      return perform({
        button: '#treasury-set',
        historyType: 'setTreasury',
        successTitle: 'Treasury updated',
        successMessage: 'The treasury is now ' + address + '.',
        errorTitle: 'Could not set the treasury',
        exec: function () {
          if (isDemo()) {
            var treasurySet = DEMO.setTreasury(currentAddress(), address);
            return { hash: treasurySet.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.setTreasury(address);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  function actionTransferOwnership() {
    return confirmWrite({
      kicker: 'Protocol admin',
      title: 'Transfer ownership',
      body: 'Ownership moves to the new address immediately. This is irreversible from the current account: only the new owner can transfer it back.',
      input: { label: 'New owner address', placeholder: '0x…', hint: 'Any valid 20-byte hex address.' },
      warning: 'You will lose access to setParams, setPaused, setTreasury, claimTreasury and transferOwnership.',
      danger: true,
      confirmLabel: 'Transfer ownership'
    }).then(function (address) {
      if (!address) return null;
      if (!UI.isHexAddress(address)) {
        UI.toast('That is not a valid 20-byte hex address.', { kind: 'error' });
        return null;
      }
      return perform({
        button: '#ownership-transfer',
        historyType: 'transferOwnership',
        successTitle: 'Ownership transferred',
        successMessage: 'The pool owner is now ' + address + '.',
        errorTitle: 'Could not transfer ownership',
        exec: function () {
          if (isDemo()) {
            var transferred = DEMO.transferOwnership(currentAddress(), address);
            return { hash: transferred.tx.hash, demo: true };
          }
          return CONTRACT.WRITE.transferOwnership(address);
        }
      });
    }).catch(function () { /* already reported */ });
  }

  /* ------------------------------------------------------------------ *
   * Demo ledger controls
   * ------------------------------------------------------------------ */

  function actionClock(seconds, label) {
    DEMO.advanceTime(seconds, label);
    return refresh({ silent: true }).then(function () {
      UI.toast(label + '. Ledger time is now ' + UI.formatTimestamp(DEMO.chainTime()) + '.', {
        kind: 'info', title: 'Ledger clock', duration: 5000
      });
    });
  }

  function actionReset() {
    return confirmWrite({
      kicker: 'Demo ledger',
      title: 'Reset the demo ledger',
      body: 'Every loan, supply and transaction is discarded and the demo desk returns to ' + UI.formatEth(DEMO.startBalance) + ' ETH with an empty pool.',
      warning: 'This cannot be undone.',
      danger: true,
      confirmLabel: 'Reset ledger'
    }).then(function (ok) {
      if (!ok) return null;
      DEMO.clearAll();
      return refresh({ silent: true }).then(function () {
        UI.toast('Ledger reset. The pool is empty and the demo desk holds ' + UI.formatEth(DEMO.startBalance) + ' ETH.', { kind: 'success' });
      });
    });
  }

  function actionReseed() {
    return confirmWrite({
      kicker: 'Demo ledger',
      title: 'Restore the sample loan book',
      body: 'Replaces the current ledger with the documented sample book: two suppliers, an overdue covered loan, an overdue shortfall loan, a repaid loan, a healthy active loan and a request waiting for funding.',
      confirmLabel: 'Restore sample book'
    }).then(function (ok) {
      if (!ok) return null;
      DEMO.reseed();
      return refresh({ silent: true }).then(function () {
        UI.toast('Sample book restored.', { kind: 'success' });
      });
    });
  }

  function switchToDemo() {
    CFG.save({ forceDemo: true });
    STATE.mode = 'demo';
    STATE.modeReason = 'Demo mode was chosen in this browser.';
    STATE.audit = DEMO.audit();
    applyDefaultScope();
    return refresh().then(function () {
      UI.toast('Demo mode is on. The local ledger mirrors the contract arithmetic; nothing is broadcast.', { kind: 'info', title: 'Demo mode' });
    });
  }

  function switchToChain() {
    CFG.save({ forceDemo: false });
    decideMode();
    applyDefaultScope();
    if (isDemo()) {
      UI.toast('A wallet and a pool address are both needed for chain mode. ' + STATE.modeReason, { kind: 'warn', title: 'Still in demo mode' });
    }
    return refresh();
  }

  /* ------------------------------------------------------------------ *
   * Event wiring
   * ------------------------------------------------------------------ */

  function wire() {
    var walletButton = one('#wallet-button');
    if (walletButton) {
      walletButton.addEventListener('click', function () {
        if (isDemo()) {
          var actor = demoActor();
          var position = DEMO.position(actor.address);
          UI.toast('Demo mode is running a local ledger with no wallet and no keys. ' + actor.label + ' holds ' +
            UI.formatEth(position.ethBalance) + ' ETH and ' + UI.formatEth(position.shares) + ' share units. ' +
            'Use "Acting as" in the banner to switch accounts, or set a pool address under Connection to use MetaMask.', {
            kind: 'info', title: 'Demo desk', duration: 10000
          });
          return;
        }
        if (!WALLET.available()) {
          UI.toast('No Ethereum wallet was detected in this browser. Install MetaMask, then reload.', {
            kind: 'warn', title: 'No wallet found', duration: 12000
          });
          return;
        }
        var action = WALLET.address() ? WALLET.refresh() : WALLET.connect();
        UI.setBusy(walletButton, true, 'Wallet');
        action.then(function () {
          if (WALLET.address()) {
            UI.toast('Connected as ' + UI.shortenAddress(WALLET.address()) + '.', { kind: 'success', title: 'Wallet' });
            return ensureSession();
          }
          return null;
        }).then(function () {
          return refresh({ silent: true });
        }).catch(function (err) {
          UI.toast(err.message, { kind: 'error', title: 'Wallet' });
        }).then(function () {
          UI.setBusy(walletButton, false);
        });
      });
    }

    var supplyForm = one('#form-supply');
    if (supplyForm) {
      supplyForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        if (supplyMode() === 'deposit') actionDeposit();
        else actionWithdraw();
      });
    }
    many('input[name="supply-mode"]').forEach(function (input) {
      input.addEventListener('change', function () {
        var amount = one('#supply-amount');
        if (amount) amount.value = '';
        setError('supply', '');
        renderSupplyPanel();
      });
    });
    many('[data-supply-preset]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var pct = Number(chip.getAttribute('data-supply-preset'));
        var amount = one('#supply-amount');
        if (!amount) return;
        if (supplyMode() === 'deposit') {
          var actor = demoActor();
          var balance = isDemo() ? actor.ethWei : WALLET.balanceWei();
          var value = (BigInt(balance) * BigInt(pct)) / 100n;
          if (pct === 25 || pct === 50 || pct === 75) {
            value -= (BigInt(balance) * 1n) / 1000n; /* leave headroom for gas on chain */
          }
          if (value < 0n) value = 0n;
          amount.value = UI.formatEth(value, { dp: 6 });
        } else if (STATE.position) {
          var shares = (BigInt(STATE.position.shares) * BigInt(pct)) / 100n;
          amount.value = shares.toString();
        }
        renderSupplyReceipt();
      });
    });
    var supplyAmount = one('#supply-amount');
    if (supplyAmount) supplyAmount.addEventListener('input', function () { setError('supply', ''); renderSupplyReceipt(); });

    var borrowForm = one('#form-borrow');
    if (borrowForm) {
      borrowForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        actionBorrow();
      });
    }
    ['#borrow-principal', '#borrow-rate', '#borrow-duration', '#borrow-collateral'].forEach(function (sel) {
      var node = one(sel);
      if (node) node.addEventListener('input', function () { setError('borrow', ''); renderBorrowPanel(); });
    });
    var useMinimum = one('#borrow-use-minimum');
    if (useMinimum) {
      useMinimum.addEventListener('click', function () {
        var input = borrowInput();
        var params = STATE.params;
        if (!params) return;
        if (!input.principal.ok || !input.rate.ok || !input.duration.ok) {
          UI.toast('Enter the principal, rate and term first, then the minimum collateral can be calculated.', { kind: 'warn' });
          return;
        }
        var quote = isDemo()
          ? DEMO.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value)
          : CONTRACT.quoteCollateral(input.principal.wei, input.rate.bps, input.duration.value, params.minCollateralBps);
        var node = one('#borrow-collateral');
        if (node) node.value = UI.formatEth(quote.requiredCollateral, { dp: 6 });
        renderBorrowPanel();
      });
    }

    many('input[name="loans-scope"]').forEach(function (input) {
      input.addEventListener('change', function () {
        STATE.scope = input.value;
        UI.skeletonRows(one('#loans-body'), 9, 2);
        loadLoans().then(function () { renderLoans(); });
      });
    });
    var loansBody = one('#loans-body');
    if (loansBody) {
      loansBody.addEventListener('click', function (evt) {
        var button = evt.target.closest ? evt.target.closest('[data-action]') : null;
        if (!button) return;
        var action = button.getAttribute('data-action');
        var loanId = button.getAttribute('data-loan-id');
        if (action === 'repay') actionRepay(loanId);
        else if (action === 'liquidate') actionLiquidate(loanId);
        else if (action === 'fund') actionFund(loanId);
        else if (action === 'cancel') actionCancel(loanId);
      });
    }

    var historyType = one('#history-type');
    if (historyType) {
      historyType.addEventListener('change', function () {
        STATE.historyType = historyType.value;
        renderHistory();
      });
    }

    var banner = one('#mode-banner');
    if (banner) {
      banner.addEventListener('change', function (evt) {
        if (evt.target && evt.target.id === 'demo-actor') {
          STATE.demoActor = evt.target.value;
          render();
        }
      });
      banner.addEventListener('click', function (evt) {
        var button = evt.target.closest ? evt.target.closest('[data-banner-action]') : null;
        if (!button) return;
        var action = button.getAttribute('data-banner-action');
        if (action === 'clock-day') actionClock(86400, 'Simulated clock advanced by 1 day');
        else if (action === 'clock-month') actionClock(2592000, 'Simulated clock advanced by 30 days');
        else if (action === 'clock-due') {
          var delta = DEMO.advanceToNextDue();
          refresh({ silent: true }).then(function () {
            UI.toast(delta
              ? 'The clock jumped past the nearest due date, so those loans are now liquidatable.'
              : 'No active loan was before its due date, so the clock advanced by one day instead.', { kind: 'info', title: 'Ledger clock' });
          });
        } else if (action === 'reset') actionReset();
        else if (action === 'reseed') actionReseed();
        else if (action === 'find-backend') {
          UI.setBusy(button, true, 'Looking');
          probeBackend().then(function (found) {
            UI.setBusy(button, false);
            render();
            if (!found) {
              UI.toast('No Flask backend answered at ' + CFG.apiBase + '. Demo mode is unaffected.', {
                kind: 'warn', title: 'No backend found'
              });
            } else if (CFG.hasContract()) {
              UI.toast('Backend found and it reports pool ' + CFG.contractAddress + '. Switch to chain mode from the banner.', {
                kind: 'success', title: 'Backend found'
              });
            } else {
              UI.toast('A backend answered but reports no pool contract address, so demo mode stays on.', {
                kind: 'warn', title: 'No pool configured'
              });
            }
          });
        } else if (action === 'to-demo') switchToDemo();
        else if (action === 'to-chain') switchToChain();
        else if (action === 'switch-chain') {
          WALLET.switchChain(CFG.chainId).then(function () {
            UI.toast('Switched to ' + CFG.chainName(CFG.chainId) + '.', { kind: 'success', title: 'Network' });
            return refresh();
          }).catch(function (err) {
            UI.toast(err.message, { kind: 'error', title: 'Network switch failed' });
          });
        }
      });
    }

    var paramsForm = one('#form-params');
    if (paramsForm) {
      paramsForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        actionSetParams();
      });
    }
    var pauseToggle = one('#pause-toggle');
    if (pauseToggle) pauseToggle.addEventListener('click', actionPause);
    var claim = one('#claim-treasury');
    if (claim) claim.addEventListener('click', actionClaimTreasury);
    var treasurySet = one('#treasury-set');
    if (treasurySet) treasurySet.addEventListener('click', actionSetTreasury);
    var ownership = one('#ownership-transfer');
    if (ownership) ownership.addEventListener('click', actionTransferOwnership);

    var settingsForm = one('#form-settings');
    if (settingsForm) {
      settingsForm.addEventListener('submit', function (evt) {
        evt.preventDefault();
        var contract = one('#s-contract').value.trim();
        var apiBase = one('#s-api').value.trim();
        if (contract && !UI.isHexAddress(contract)) {
          UI.toast('The contract address must be 20 bytes of hex, for example 0x7A3f…', { kind: 'error', title: 'Connection' });
          return;
        }
        CFG.save({ contractAddress: contract, apiBase: apiBase });
        CONTRACT.resetCache();
        decideMode();
        applyDefaultScope();
        if (isDemo()) {
          UI.toast('Saved. Still in demo mode: ' + STATE.modeReason, { kind: 'warn', title: 'Connection', duration: 9000 });
        } else {
          UI.toast('Saved. Reading the pool from ' + CFG.chainName(CFG.chainId) + '.', { kind: 'success', title: 'Connection' });
        }
        refresh();
      });
    }
    var clearSettings = one('#settings-clear');
    if (clearSettings) {
      clearSettings.addEventListener('click', function () {
        CFG.clearSaved();
        CONTRACT.resetCache();
        decideMode();
        UI.toast('Saved connection settings cleared. Reloading defaults.', { kind: 'info' });
        refresh();
      });
    }
    var diagnostics = one('#copy-diagnostics');
    if (diagnostics) {
      diagnostics.addEventListener('click', function () {
        var stats = STATE.stats || {};
        var lines = [
          'MicroLend diagnostics ' + new Date().toISOString(),
          'mode: ' + STATE.mode + ' (' + STATE.modeReason + ')',
          'page protocol: ' + global.location.protocol,
          'contract: ' + (CFG.contractAddress || 'none'),
          'api base: ' + CFG.apiBase + ' (backend ' + (STATE.backendOnline === null ? 'unknown' : STATE.backendOnline ? 'online' : 'offline') + ')',
          'chain: ' + CFG.chainName(CFG.chainId) + ' (wallet ' + (WALLET.chainId() || 'not connected') + ')',
          'wallet: ' + (WALLET.address() || 'not connected') + ' via ' + WALLET.providerKind(),
          'ethers: ' + (CONTRACT.available() ? (global.ethers && global.ethers.version ? global.ethers.version : 'loaded') : 'not loaded') + ' (abi source ' + (global.__ML_ABI_SOURCE__ || 'unknown') + ')',
          'pool: shares=' + String(stats.totalShares || 0) + ' liquidity=' + String(stats.totalLiquidity || 0) +
            ' reserved=' + String(stats.reservedLiquidity || 0) + ' loans=' + String(stats.loanCount || 0),
          'audit: ' + (STATE.audit ? (STATE.audit.balanced ? 'balanced' : 'difference ' + String(STATE.audit.difference) + ' wei') : 'n/a')
        ];
        UI.copyText(lines.join('\n'), 'Diagnostics');
      });
    }

    DOC.addEventListener('click', function (evt) {
      var copy = evt.target.closest ? evt.target.closest('[data-copy]') : null;
      if (copy) UI.copyText(copy.getAttribute('data-copy'), 'Address');
    });

    WALLET.on('change', function () {
      if (isDemo()) return;
      renderTopbar();
      renderBanner();
    });
    WALLET.on('accounts', function () {
      if (isDemo()) return;
      refresh({ silent: true }).then(function () {
        if (WALLET.address()) ensureSession();
      });
    });
    WALLET.on('chain', function () {
      if (isDemo()) return;
      CONTRACT.resetCache();
      refresh({ silent: true });
    });

    CFG.on('api', function () {
      STATE.backendOnline = API.status().online;
    });

    DOC.addEventListener('visibilitychange', function () {
      if (DOC.visibilityState === 'visible') refresh({ silent: true });
    });
  }

  /* ------------------------------------------------------------------ *
   * Backend session
   * ------------------------------------------------------------------ */

  function ensureSession() {
    if (isDemo() || !WALLET.address()) return Promise.resolve(false);
    if (!STATE.backendOnline) return Promise.resolve(false);
    if (API.hasSession()) return Promise.resolve(true);
    return API.login(WALLET.address(), function (message, address) {
      return WALLET.signMessage(message, address);
    }).then(function () {
      UI.toast('Signed in to the backend indexer.', { kind: 'success', title: 'Session', duration: 4000 });
      return true;
    }).catch(function (err) {
      UI.toast(err.userMessage || err.message, { kind: 'warn', title: 'Backend session', duration: 9000 });
      return false;
    });
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function startPolling() {
    if (STATE.timer) clearInterval(STATE.timer);
    STATE.timer = setInterval(function () {
      if (DOC.visibilityState !== 'visible') return;
      if (STATE.busy > 0) return;
      if (!isDemo() && !CONTRACT.available()) return;
      refresh({ silent: true });
    }, REFRESH_MS);
  }

  function probeBackend() {
    STATE.probed = true;
    return API.config().then(function (remote) {
      STATE.remote = true;
      STATE.backendOnline = true;
      var hadAddress = CFG.hasContract();
      CFG.applyRemote(remote || {});
      if (!hadAddress && CFG.hasContract()) {
        decideMode();
        UI.toast('A backend is running and reports pool ' + UI.shortenAddress(CFG.contractAddress) + '. ' +
          'Chain mode is available from the banner.', { kind: 'info', title: 'Backend found', duration: 9000 });
      }
      return true;
    }, function () {
      STATE.remote = false;
      STATE.backendOnline = false;
      return false;
    });
  }

  /* Served from a real origin (Flask, a static server) a same-origin /api probe
     is expected; opened straight off disk it would only produce a failed network
     request in the console, so the demo banner offers it as an explicit action
     instead of firing it unasked. */
  function shouldProbeAtBoot() {
    var protocol = global.location && global.location.protocol;
    if (protocol === 'file:') return false;
    return true;
  }

  /* Which loans the book shows by default: the whole book in demo mode (the
     seeded loans belong to the sample actors, and an empty table would hide the
     most instructive rows) and the connected account's own loans on chain. */
  function applyDefaultScope() {
    var scope = (isDemo() || !WALLET.address()) ? 'all' : 'mine';
    STATE.scope = scope;
    many('input[name="loans-scope"]').forEach(function (input) {
      input.checked = input.value === scope;
    });
  }

  function init() {
    decideMode();
    DEMO.ensure();
    applyDefaultScope();
    wire();

    /* First paint from whatever is local, so the page is never blank. */
    if (isDemo()) {
      STATE.audit = DEMO.audit();
      render();
    } else {
      UI.skeletonRows(one('#loans-body'), 9, 3);
      render();
    }

    var chain = Promise.resolve();
    if (!isDemo()) {
      chain = probeBackend().then(function () {
        return WALLET.available() ? WALLET.init() : null;
      }).then(function () {
        if (WALLET.address()) return ensureSession();
        return null;
      });
    } else if (shouldProbeAtBoot()) {
      /* Served over HTTP: a same-origin /api/config is expected. The demo stays
         the default; a backend only makes chain mode *available*. */
      chain = probeBackend().then(function (found) {
        if (found) {
          decideMode();
          render();
        }
        return null;
      });
    }

    return chain.then(function () {
      return refresh({ silent: isDemo() });
    }).then(function () {
      startPolling();
      if (isDemo()) {
        var stats = STATE.stats;
        UI.toast('Demo mode: this board runs a local ledger that mirrors the contract arithmetic. ' +
          'Supply, borrow, repay and liquidate all work with no wallet and no testnet ETH.', {
          kind: 'info', title: 'Demo data — no real chain', duration: 12000
        });
        if (stats && stats.totalLiquidity === 0n) {
          UI.toast('The pool is empty. Supply ETH first, then request a loan: the pool pays out as soon as it has free liquidity.', {
            kind: 'info', title: 'First step', duration: 11000
          });
        }
      } else {
        UI.toast('Reading the pool from ' + CFG.chainName(CFG.chainId) + '.', {
          kind: 'info', title: 'Chain mode', duration: 7000
        });
      }
      return STATE;
    });
  }

  global.ML_APP = {
    init: init,
    refresh: refresh,
    render: render,
    state: function () { return STATE; },
    demo: function () { return DEMO; }
  };

  if (DOC.readyState === 'loading') {
    DOC.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : this);
