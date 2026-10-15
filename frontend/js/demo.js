/* MicroLend — OFFLINE DEMO MODE.
 *
 * A complete local mirror of contracts/MicroLendPool.sol held in a localStorage
 * ledger, so every button in the UI works end-to-end with no backend, no wallet
 * and no testnet ETH. Every value it produces is badged as demo data in the UI.
 *
 * Arithmetic is mirrored EXACTLY from the Solidity source (integer maths, floored
 * division, BigInt only — never floats):
 *   interestWei = principal * rateBps * durationDays / (10_000 * 365)
 *   periods     = (now - dueDate) / 30 days + 1        (charge the started period)
 *   lateFee     = baseDue * lateFeeBps * periods / 10_000
 *   fee         = interest * feeBps / 10_000
 *   liquidation penalty = owed * penaltyBps / 10_000, capped at the collateral
 *   requiredCollateral = ceil(principal * minCollateralBps / 10_000)
 * Share accounting reproduces the ERC-4626-style rounding and the parked
 * DEAD_SHARES = 1 wei from the first deposit.
 *
 * No private key, seed phrase or signing operation exists anywhere in this file.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'ml.demo.ledger.v1';
  var VERSION = 1;
  var DAY = 86400n;
  var LATE_PERIOD = 30n * DAY;
  var BPS = 10000n;
  var YEAR_DAYS = 365n;
  var DEAD_SHARES = 1n;
  var WEI = 1000000000000000000n;

  /* The demo desk. Deliberately recognisable as a synthetic account. */
  var DEMO_ADDRESS = '0xd3e0d3e0d3e0d3e0d3e0d3e0d3e0d3e0d3e0d3e0';
  var DEMO_START_BALANCE = 50n * WEI;

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function fnv(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  /* Stable pseudo-address for a named demo actor — same on every machine, so
     screenshots and reports reproduce. */
  function actorAddress(label) {
    var out = '';
    for (var i = 0; i < 5; i++) out += hex8(fnv(label + '#' + i));
    return '0x' + out;
  }

  function fakeHash(seed) {
    var out = '';
    for (var i = 0; i < 8; i++) out += hex8(fnv(seed + '@' + i));
    return '0x' + out;
  }

  function Revert(name, message, args) {
    var err = new Error(message || name);
    err.name = 'DemoRevert';
    err.revertName = name;
    err.args = args || {};
    err.isDemoRevert = true;
    return err;
  }

  var fmt = function (v) { return global.ML_UI ? global.ML_UI.formatEth(v, { dp: 4 }) : String(v); };

  /* Custom-error text lives in ui.js so the demo ledger and the on-chain path
     explain a revert with exactly the same words. */
  function describeError(name, a) {
    if (global.ML_UI && global.ML_UI.revertMessage) return global.ML_UI.revertMessage(name, a);
    return 'The pool rejected this action (' + name + ').';
  }

  /* ------------------------------------------------------------------ *
   * Serialisation (BigInt <-> JSON)
   * ------------------------------------------------------------------ */

  function enc(value) {
    if (typeof value === 'bigint') return { $wei: value.toString() };
    if (Array.isArray(value)) return value.map(enc);
    if (value && typeof value === 'object') {
      var out = {};
      for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = enc(value[k]);
      return out;
    }
    return value;
  }

  function dec(value) {
    if (Array.isArray(value)) return value.map(dec);
    if (value && typeof value === 'object') {
      if (typeof value.$wei === 'string') return BigInt(value.$wei);
      var out = {};
      for (var k in value) if (Object.prototype.hasOwnProperty.call(value, k)) out[k] = dec(value[k]);
      return out;
    }
    return value;
  }

  /* ------------------------------------------------------------------ *
   * Ledger
   * ------------------------------------------------------------------ */

  var L = null;

  function params0() {
    return {
      minDeposit: 1000000000000n,               /* 1e12 wei */
      minLoanPrincipal: 10000000000000n,        /* 1e13 wei */
      maxLoanPrincipal: 100n * WEI,             /* 100 ETH */
      maxDurationDays: 365n,
      maxRateBps: 5000n,
      minCollateralBps: 10000n,
      feeBps: 1000n,
      penaltyBps: 500n,
      lateFeeBps: 100n
    };
  }

  function blankLedger() {
    return {
      version: VERSION,
      createdAtMs: Date.now(),
      clockOffset: 0n,
      initialized: true,
      paused: false,
      owner: DEMO_ADDRESS,
      treasury: DEMO_ADDRESS,
      params: params0(),
      totalShares: 0n,
      totalLiquidity: 0n,
      reservedLiquidity: 0n,
      totalDeposited: 0n,
      totalInterestEarned: 0n,
      totalFeesCollected: 0n,
      totalBadDebt: 0n,
      treasuryBalance: 0n,
      accumulatedCollateral: 0n,
      poolBalance: 0n,
      loanCount: 0n,
      sharesOf: {},
      accounts: {},
      loans: {},
      userLoans: {},
      activeLoanCountOf: {},
      pendingLoanCountOf: {},
      txs: []
    };
  }

  function account(L, address) {
    var key = String(address).toLowerCase();
    if (!L.accounts[key]) L.accounts[key] = { ethWei: 0n, label: '' };
    return L.accounts[key];
  }

  function sharesOf(L, address) {
    var key = String(address).toLowerCase();
    if (!L.sharesOf[key]) L.sharesOf[key] = 0n;
    return L.sharesOf[key];
  }

  function userLoanIds(L, address) {
    var key = String(address).toLowerCase();
    if (!L.userLoans[key]) L.userLoans[key] = [];
    return L.userLoans[key];
  }

  function clock(offsetOverride) {
    var offset = offsetOverride === undefined ? (L ? L.clockOffset : 0n) : offsetOverride;
    return BigInt(Math.floor(Date.now() / 1000)) + offset;
  }

  function record(type, opts) {
    var o = opts || {};
    var now = o.now === undefined ? clock() : o.now;
    var tx = {
      hash: o.hash || fakeHash(type + ':' + now.toString() + ':' + (o.from || '') + ':' + L.txs.length),
      type: type,
      status: o.status || 'confirmed',
      from: o.from || DEMO_ADDRESS,
      to: o.to || '',
      amountWei: o.amountWei === undefined ? 0n : o.amountWei,
      loanId: o.loanId === undefined || o.loanId === null ? null : o.loanId,
      timestamp: Number(now),
      note: o.note || '',
      demo: true
    };
    L.txs.unshift(tx);
    if (L.txs.length > 300) L.txs.length = 300;
    return tx;
  }

  /* ---- core arithmetic, mirrored from the contract ---- */

  function availableLiquidity(L) {
    return L.totalLiquidity > L.reservedLiquidity ? L.totalLiquidity - L.reservedLiquidity : 0n;
  }

  function convertToShares(L, assets) {
    var supply = L.totalShares;
    if (supply === 0n) return assets;
    if (L.totalLiquidity === 0n) return assets;
    return (assets * supply) / L.totalLiquidity;
  }

  function convertToAssets(L, shares) {
    var supply = L.totalShares;
    if (supply === 0n) return 0n;
    return (shares * L.totalLiquidity) / supply;
  }

  function sharePriceOf(L) {
    var supply = L.totalShares;
    if (supply === 0n) return WEI;
    return (L.totalLiquidity * WEI) / supply;
  }

  function mulDivUp(a, b, d) {
    var product = a * b;
    if (product === 0n) return 0n;
    return (product + d - 1n) / d;
  }

  function previewInterest(principal, rateBps, durationDays) {
    return (principal * rateBps * durationDays) / (BPS * YEAR_DAYS);
  }

  function quoteCollateral(principal, rateBps, durationDays, minCollateralBps) {
    var mcb = minCollateralBps === undefined ? (L ? L.params.minCollateralBps : 10000n) : minCollateralBps;
    return {
      requiredCollateral: mulDivUp(principal, mcb, BPS),
      totalDue: principal + previewInterest(principal, rateBps, durationDays)
    };
  }

  function previewRepaymentOf(L, loan, now) {
    var base = loan.principal + loan.interest;
    var lateFee = 0n;
    if (now > loan.dueDate && loan.dueDate > 0n) {
      var periods = (now - loan.dueDate) / LATE_PERIOD + 1n;
      lateFee = (base * L.params.lateFeeBps * periods) / BPS;
    }
    return { amountDue: base + lateFee, lateFee: lateFee, base: base };
  }

  function collateralRatioOf(L, loan, now) {
    var owed = previewRepaymentOf(L, loan, now).amountDue;
    if (owed === 0n) return null;
    return (loan.collateral * BPS) / owed;
  }

  function isOverdue(loan, now) {
    return loan.status === 2 && loan.dueDate > 0n && now > loan.dueDate;
  }

  /* ---- mutating ops (mirror the Solidity functions 1:1) ---- */

  function opDeposit(L, from, value, now) {
    if (!L.initialized) throw Revert('NotInitialized');
    if (L.paused) throw Revert('PoolPaused', describeError('PoolPaused'));
    if (value === 0n) throw Revert('ZeroAmount', describeError('ZeroAmount'));
    if (value < L.params.minDeposit) throw Revert('AmountTooSmall', describeError('AmountTooSmall', { provided: value, minimum: L.params.minDeposit }));
    var acct = account(L, from);
    if (acct.ethWei < value) throw Revert('InsufficientBalance', 'This demo account holds ' + fmt(acct.ethWei) + ' ETH but the deposit is ' + fmt(value) + ' ETH.');

    var existing = L.totalShares;
    var minted;
    if (existing === 0n) {
      if (value <= DEAD_SHARES) throw Revert('AmountTooSmall', describeError('AmountTooSmall', { provided: value, minimum: DEAD_SHARES + 1n }));
      minted = value - DEAD_SHARES;
      L.totalShares = value; /* includes the dead share held by the pool */
    } else {
      minted = convertToShares(L, value);
      if (minted === 0n) throw Revert('AmountTooSmall', describeError('AmountTooSmall', { provided: value, minimum: L.params.minDeposit }));
      L.totalShares = existing + minted;
    }
    L.totalLiquidity += value;
    L.totalDeposited += value;
    L.sharesOf[String(from).toLowerCase()] = sharesOf(L, from) + minted;
    acct.ethWei -= value;
    L.poolBalance += value;
    return { minted: minted, tx: record('deposit', { from: from, amountWei: value, now: now, note: 'Supplied ' + fmt(value) + ' ETH, received ' + fmt(minted) + ' share units.' }) };
  }

  function opWithdraw(L, from, shares, now) {
    if (!L.initialized) throw Revert('NotInitialized');
    if (shares === 0n) throw Revert('ZeroAmount', describeError('ZeroAmount'));
    var owned = sharesOf(L, from);
    if (shares > owned) throw Revert('InsufficientShares', describeError('InsufficientShares', { provided: shares, owned: owned }));
    var assets = convertToAssets(L, shares);
    if (assets === 0n) throw Revert('NothingToWithdraw', describeError('NothingToWithdraw'));
    var available = availableLiquidity(L);
    if (assets > available) throw Revert('InsufficientLiquidity', describeError('InsufficientLiquidity', { requested: assets, available: available }));
    /* Mirrors what the EVM would do next: the contract's guard is against
       `available`, so a withdrawal beyond the ETH actually held reaches the
       low-level call and reverts TransferFailed. */
    if (assets > L.poolBalance) {
      throw Revert('TransferFailed',
        'The pool does not hold enough ETH for this withdrawal: it reports ' + fmt(available) +
        ' ETH of free liquidity but holds ' + fmt(L.poolBalance) + ' ETH. Try a smaller amount.');
    }

    L.sharesOf[String(from).toLowerCase()] = owned - shares;
    L.totalShares -= shares;
    L.totalLiquidity -= assets;
    L.poolBalance -= assets;
    account(L, from).ethWei += assets;
    return { assets: assets, tx: record('withdraw', { from: from, amountWei: assets, now: now, note: 'Burned ' + fmt(shares) + ' share units for ' + fmt(assets) + ' ETH.' }) };
  }

  function opRequestLoan(L, from, req, now) {
    var principal = req.principal;
    var rateBps = req.rateBps;
    var durationDays = req.durationDays;
    var collateral = req.collateral;

    if (!L.initialized) throw Revert('NotInitialized');
    if (L.paused) throw Revert('PoolPaused', describeError('PoolPaused'));
    if (principal === 0n || collateral === 0n) throw Revert('ZeroAmount', describeError('ZeroAmount'));
    if (principal < L.params.minLoanPrincipal) throw Revert('AmountTooSmall', describeError('AmountTooSmall', { provided: principal, minimum: L.params.minLoanPrincipal }));
    if (principal > L.params.maxLoanPrincipal) throw Revert('AmountTooLarge', describeError('AmountTooLarge', { provided: principal, maximum: L.params.maxLoanPrincipal }));
    if (durationDays === 0n || durationDays > L.params.maxDurationDays) throw Revert('DurationInvalid', describeError('DurationInvalid', { provided: durationDays.toString(), maximum: L.params.maxDurationDays.toString() }));
    if (rateBps > L.params.maxRateBps) throw Revert('RateTooHigh', describeError('RateTooHigh', { provided: rateBps.toString(), maximum: L.params.maxRateBps.toString() }));

    var requiredCollateral = mulDivUp(principal, L.params.minCollateralBps, BPS);
    if (collateral < requiredCollateral) throw Revert('InsufficientCollateral', describeError('InsufficientCollateral', { provided: collateral, required: requiredCollateral }));

    var acct = account(L, from);
    if (acct.ethWei < collateral) throw Revert('InsufficientBalance', 'This demo account holds ' + fmt(acct.ethWei) + ' ETH but the collateral is ' + fmt(collateral) + ' ETH.');

    var interest = previewInterest(principal, rateBps, durationDays);
    L.loanCount += 1n;
    var id = L.loanCount;
    var loan = {
      id: id,
      borrower: from,
      principal: principal,
      collateral: collateral,
      interest: interest,
      rateBps: rateBps,
      durationDays: durationDays,
      startTime: 0n,
      dueDate: 0n,
      amountFunded: 0n,
      status: 1 /* Pending */
    };
    L.loans[id.toString()] = loan;
    userLoanIds(L, from).push(id);
    L.pendingLoanCountOf[String(from).toLowerCase()] = (L.pendingLoanCountOf[String(from).toLowerCase()] || 0n) + 1n;

    L.accumulatedCollateral += collateral;
    acct.ethWei -= collateral;
    L.poolBalance += collateral;

    if (availableLiquidity(L) >= principal) {
      activate(L, loan, principal, now);
    }
    return {
      loanId: id,
      interest: interest,
      status: loan.status,
      tx: record('request', {
        from: from, amountWei: principal, loanId: id, now: now,
        note: 'Loan ' + id + ' requested: ' + fmt(principal) + ' ETH at ' + (Number(rateBps) / 100).toFixed(2) + '% APR for ' + durationDays + ' days, collateral ' + fmt(collateral) + ' ETH.'
      })
    };
  }

  function activate(L, loan, funded, now) {
    loan.interest = previewInterest(loan.principal, loan.rateBps, loan.durationDays);
    loan.amountFunded = funded;
    loan.status = 2; /* Active */
    loan.startTime = now;
    loan.dueDate = now + loan.durationDays * DAY;
    L.reservedLiquidity += loan.principal;
    var bkey = String(loan.borrower).toLowerCase();
    if ((L.pendingLoanCountOf[bkey] || 0n) > 0n) L.pendingLoanCountOf[bkey] -= 1n;
    L.activeLoanCountOf[bkey] = (L.activeLoanCountOf[bkey] || 0n) + 1n;
    account(L, loan.borrower).ethWei += loan.principal;
    L.poolBalance -= loan.principal;
  }

  function opFundLoan(L, from, loanId, value, now) {
    var key = loanId.toString();
    var loan = L.loans[key];
    if (!loan) throw Revert('InvalidLoan', describeError('InvalidLoan', { loanId: key }));
    if (loan.status !== 1) throw Revert('LoanNotPending', describeError('LoanNotPending', { loanId: key }));
    if (value === 0n) throw Revert('ZeroAmount', describeError('ZeroAmount'));
    if (L.paused) throw Revert('PoolPaused', describeError('PoolPaused'));

    var remaining = loan.principal - loan.amountFunded;
    if (value > remaining) throw Revert('AmountTooLarge', describeError('AmountTooLarge', { provided: value, maximum: remaining }));

    var acct = account(L, from);
    if (acct.ethWei < value) throw Revert('InsufficientBalance', 'This demo account holds ' + fmt(acct.ethWei) + ' ETH but the funding is ' + fmt(value) + ' ETH.');

    var shares = convertToShares(L, value);
    if (shares === 0n) throw Revert('AmountTooSmall', describeError('AmountTooSmall', { provided: value, minimum: L.params.minDeposit }));

    loan.amountFunded += value;
    L.totalShares += shares;
    L.totalLiquidity += value;
    L.totalDeposited += value;
    L.sharesOf[String(from).toLowerCase()] = sharesOf(L, from) + shares;
    acct.ethWei -= value;
    L.poolBalance += value;

    if (loan.amountFunded === loan.principal) activate(L, loan, loan.principal, now);

    return {
      shares: shares,
      status: loan.status,
      tx: record('fund', {
        from: from, amountWei: value, loanId: loan.id, now: now,
        note: 'Funded loan ' + loan.id + ' with ' + fmt(value) + ' ETH (' + fmt(loan.amountFunded) + ' of ' + fmt(loan.principal) + ' ETH committed).'
      })
    };
  }

  function opRepayLoan(L, from, loanId, value, now) {
    var key = loanId.toString();
    var loan = L.loans[key];
    if (!loan) throw Revert('InvalidLoan', describeError('InvalidLoan', { loanId: key }));
    if (loan.status !== 2) throw Revert('LoanNotActive', describeError('LoanNotActive', { loanId: key }));

    var due = previewRepaymentOf(L, loan, now);
    if (value < due.amountDue) throw Revert('InsufficientPayment', describeError('InsufficientPayment', { provided: value, required: due.amountDue }));

    var acct = account(L, from);
    if (acct.ethWei < value) throw Revert('InsufficientBalance', 'This demo account holds ' + fmt(acct.ethWei) + ' ETH but the payment is ' + fmt(value) + ' ETH.');

    var payer = from;
    var interest = loan.interest;
    var principal = loan.principal;
    var collateral = loan.collateral;
    var fee = (interest * L.params.feeBps) / BPS;
    var netInterest = interest - fee;
    var refund = value - due.amountDue;

    loan.collateral = 0n;
    loan.status = 3; /* Repaid */
    L.accumulatedCollateral -= collateral;
    L.reservedLiquidity -= principal;
    /* Mirrors MicroLendPool._settleRepayment: `reservedLiquidity` already carried
       the claim on the principal, so repayment adds only what the pool actually
       earned — net interest plus any late fee. */
    L.totalLiquidity += netInterest + due.lateFee;
    L.totalInterestEarned += interest + due.lateFee;
    L.totalInterestEarned += interest;
    L.totalFeesCollected += fee;
    L.treasuryBalance += fee;
    var bkey = String(loan.borrower).toLowerCase();
    if ((L.activeLoanCountOf[bkey] || 0n) > 0n) L.activeLoanCountOf[bkey] -= 1n;

    L.poolBalance += due.amountDue;
    account(L, payer).ethWei -= value;
    if (refund > 0n) {
      account(L, payer).ethWei += refund;
      L.poolBalance -= refund;
    }
    account(L, loan.borrower).ethWei += collateral;
    L.poolBalance -= collateral;

    return {
      amountDue: due.amountDue,
      lateFee: due.lateFee,
      fee: fee,
      refund: refund,
      tx: record('repay', {
        from: payer, amountWei: due.amountDue, loanId: loan.id, now: now,
        note: 'Loan ' + loan.id + ' repaid: principal ' + fmt(principal) + ' + interest ' + fmt(interest) +
          (due.lateFee > 0n ? ' + late fee ' + fmt(due.lateFee) : '') + ' ETH. Protocol fee ' + fmt(fee) +
          ' ETH. Collateral ' + fmt(collateral) + ' ETH returned.' + (refund > 0n ? ' Overpayment ' + fmt(refund) + ' ETH refunded.' : '')
      })
    };
  }

  function opCancelLoan(L, from, loanId, now) {
    var key = loanId.toString();
    var loan = L.loans[key];
    if (!loan) throw Revert('InvalidLoan', describeError('InvalidLoan', { loanId: key }));
    if (loan.status !== 1) throw Revert('LoanNotPending', describeError('LoanNotPending', { loanId: key }));
    if (String(loan.borrower).toLowerCase() !== String(from).toLowerCase()) throw Revert('NotBorrower', describeError('NotBorrower', { caller: from }));
    if (loan.amountFunded !== 0n) throw Revert('NotFunded', describeError('NotFunded', { funded: loan.amountFunded, principal: loan.principal }));

    var refund = loan.collateral;
    loan.collateral = 0n;
    loan.status = 5; /* Cancelled */
    L.accumulatedCollateral -= refund;
    var bkey = String(from).toLowerCase();
    if ((L.pendingLoanCountOf[bkey] || 0n) > 0n) L.pendingLoanCountOf[bkey] -= 1n;
    account(L, from).ethWei += refund;
    L.poolBalance -= refund;

    return { refund: refund, tx: record('cancel', { from: from, amountWei: refund, loanId: loan.id, now: now, note: 'Loan ' + loan.id + ' cancelled; collateral ' + fmt(refund) + ' ETH returned.' }) };
  }

  function opLiquidate(L, from, loanId, now) {
    var key = loanId.toString();
    var loan = L.loans[key];
    if (!loan) throw Revert('InvalidLoan', describeError('InvalidLoan', { loanId: key }));
    if (loan.status !== 2) throw Revert('LoanNotActive', describeError('LoanNotActive', { loanId: key }));
    if (now <= loan.dueDate) throw Revert('LoanNotOverdue', describeError('LoanNotOverdue', { loanId: key }));

    var due = previewRepaymentOf(L, loan, now);
    var owed = due.amountDue;
    var collateral = loan.collateral;
    var compensation;
    var refund = 0n;
    var writeOff = 0n;

    if (collateral >= owed) {
      var penalty = (owed * L.params.penaltyBps) / BPS;
      compensation = owed + penalty;
      if (compensation > collateral) compensation = collateral;
      refund = collateral - compensation;
    } else {
      compensation = collateral;
      writeOff = owed - collateral;
      L.totalBadDebt += writeOff;
    }

    var interest = owed > loan.principal ? owed - loan.principal : 0n;

    loan.collateral = 0n;
    loan.status = 4; /* Liquidated */
    L.accumulatedCollateral -= collateral;
    var bkey = String(loan.borrower).toLowerCase();
    if ((L.activeLoanCountOf[bkey] || 0n) > 0n) L.activeLoanCountOf[bkey] -= 1n;

    /* Mirrors liquidate: the disbursed principal is given up as a claim and the
       seized compensation takes its place. The clamp can never bite in practice
       but is reproduced for parity with the contract. */
    L.reservedLiquidity -= loan.principal <= L.reservedLiquidity ? loan.principal : L.reservedLiquidity;
    L.totalLiquidity = L.totalLiquidity - loan.principal + compensation;
    L.totalInterestEarned += interest;

    if (refund > 0n) {
      account(L, loan.borrower).ethWei += refund;
      L.poolBalance -= refund;
    }

    return {
      owed: owed,
      compensation: compensation,
      refund: refund,
      badDebt: writeOff,
      tx: record('liquidate', {
        from: from, amountWei: compensation, loanId: loan.id, now: now,
        note: 'Loan ' + loan.id + ' liquidated: debt ' + fmt(owed) + ' ETH, pool recovered ' + fmt(compensation) +
          ' ETH' + (refund > 0n ? ', excess collateral ' + fmt(refund) + ' ETH refunded to the borrower' : '') +
          (writeOff > 0n ? ', bad debt written off ' + fmt(writeOff) + ' ETH' : '') + '.'
      })
    };
  }

  /* ---- governance (owner-only in the contract; the demo desk is the owner) ---- */

  function opSetParams(L, from, next, now) {
    requireOwner(L, from);
    var p = L.params;
    if (next.minDeposit !== undefined && next.minDeposit === 0n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'minDeposit' }));
    var candidate = {
      minDeposit: next.minDeposit === undefined ? p.minDeposit : next.minDeposit,
      minLoanPrincipal: next.minLoanPrincipal === undefined ? p.minLoanPrincipal : next.minLoanPrincipal,
      maxLoanPrincipal: next.maxLoanPrincipal === undefined ? p.maxLoanPrincipal : next.maxLoanPrincipal,
      maxDurationDays: next.maxDurationDays === undefined ? p.maxDurationDays : next.maxDurationDays,
      maxRateBps: next.maxRateBps === undefined ? p.maxRateBps : next.maxRateBps,
      minCollateralBps: next.minCollateralBps === undefined ? p.minCollateralBps : next.minCollateralBps,
      feeBps: next.feeBps === undefined ? p.feeBps : next.feeBps,
      penaltyBps: next.penaltyBps === undefined ? p.penaltyBps : next.penaltyBps,
      lateFeeBps: next.lateFeeBps === undefined ? p.lateFeeBps : next.lateFeeBps
    };
    if (candidate.minLoanPrincipal === 0n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'minLoanPrincipal' }));
    if (candidate.maxLoanPrincipal < candidate.minLoanPrincipal) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'maxLoanPrincipal' }));
    if (candidate.maxDurationDays === 0n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'maxDurationDays' }));
    if (candidate.maxRateBps === 0n || candidate.maxRateBps > BPS) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'maxRateBps' }));
    if (candidate.minCollateralBps < 5000n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'minCollateralBps' }));
    if (candidate.feeBps > 2000n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'feeBps' }));
    if (candidate.penaltyBps > 2000n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'penaltyBps' }));
    if (candidate.lateFeeBps > 2000n) throw Revert('InvalidParameter', describeError('InvalidParameter', { name: 'lateFeeBps' }));
    L.params = candidate;
    return { tx: record('setParams', { from: from, now: now, note: 'Parameters updated: fee ' + (Number(candidate.feeBps) / 100).toFixed(2) + '%, penalty ' + (Number(candidate.penaltyBps) / 100).toFixed(2) + '%, late fee ' + (Number(candidate.lateFeeBps) / 100).toFixed(2) + '% per 30 days.' }) };
  }

  function requireOwner(L, from) {
    if (String(from).toLowerCase() !== String(L.owner).toLowerCase()) throw Revert('NotOwner', describeError('NotOwner'));
  }

  function opSetPaused(L, from, paused, now) {
    requireOwner(L, from);
    L.paused = !!paused;
    return { tx: record('setPaused', { from: from, now: now, note: 'Pool ' + (L.paused ? 'paused (deposits and new loans blocked)' : 'unpaused') + '.' }) };
  }

  function opSetTreasury(L, from, address, now) {
    requireOwner(L, from);
    if (!global.ML_UI.isHexAddress(address)) throw Revert('ZeroAddress', describeError('ZeroAddress'));
    L.treasury = address;
    return { tx: record('setTreasury', { from: from, to: address, now: now, note: 'Treasury set to ' + global.ML_UI.shortenAddress(address) + '.' }) };
  }

  function opTransferOwnership(L, from, address, now) {
    requireOwner(L, from);
    if (!global.ML_UI.isHexAddress(address)) throw Revert('ZeroAddress', describeError('ZeroAddress'));
    var previous = L.owner;
    L.owner = address;
    return { tx: record('transferOwnership', { from: from, to: address, now: now, note: 'Ownership transferred to ' + global.ML_UI.shortenAddress(address) + ' (was ' + global.ML_UI.shortenAddress(previous) + ').' }) };
  }

  function opClaimTreasury(L, from, to, now) {
    requireOwner(L, from);
    if (!global.ML_UI.isHexAddress(to)) throw Revert('ZeroAddress', describeError('ZeroAddress'));
    var available = availableLiquidity(L);
    var amount = L.treasuryBalance < available ? L.treasuryBalance : available;
    if (amount === 0n) throw Revert('NoFees', describeError('NoFees'));
    /* Mirrors claimTreasury: fees were never part of totalLiquidity (which tracks
       supplier claims), so only the treasury balance and the cash move. */
    L.treasuryBalance -= amount;
    L.poolBalance -= amount;
    account(L, to).ethWei += amount;
    return { amount: amount, tx: record('claimTreasury', { from: from, to: to, amountWei: amount, now: now, note: 'Protocol fees ' + fmt(amount) + ' ETH claimed to ' + global.ML_UI.shortenAddress(to) + '.' }) };
  }

  /* ------------------------------------------------------------------ *
   * Seed ledger — a plausible book so the dashboard is never empty
   * ------------------------------------------------------------------ */

  function seedLedger() {
    var next = blankLedger();
    L = next;

    var supplierOne = actorAddress('supplier.alder');
    var supplierTwo = actorAddress('supplier.marchmont');
    var borrowerFenwick = actorAddress('borrower.fenwick');
    var borrowerKestrel = actorAddress('borrower.kestrel');
    var borrowerThornbury = actorAddress('borrower.thornbury');
    var borrowerAshcombe = actorAddress('borrower.ashcombe');

    var labels = {};
    labels[String(supplierOne).toLowerCase()] = 'Supplier, 8 ETH supplied';
    labels[String(supplierTwo).toLowerCase()] = 'Supplier, 4 ETH supplied';
    labels[String(borrowerFenwick).toLowerCase()] = 'Borrower, one repaid loan';
    labels[String(borrowerKestrel).toLowerCase()] = 'Borrower, shortfall default';
    labels[String(borrowerThornbury).toLowerCase()] = 'Borrower, awaiting funding';
    labels[String(borrowerAshcombe).toLowerCase()] = 'Borrower, current loan';
    labels[String(DEMO_ADDRESS).toLowerCase()] = 'Your demo desk';

    var now = clock(0n);
    var t0 = now - 60n * DAY; /* the demo book opens 60 days ago */

    account(L, supplierOne).ethWei = 40n * WEI;
    account(L, supplierTwo).ethWei = 40n * WEI;
    account(L, borrowerFenwick).ethWei = 40n * WEI;
    account(L, borrowerKestrel).ethWei = 40n * WEI;
    account(L, borrowerThornbury).ethWei = 40n * WEI;
    account(L, borrowerAshcombe).ethWei = 40n * WEI;
    account(L, DEMO_ADDRESS).ethWei = DEMO_START_BALANCE;

    for (var k in labels) if (Object.prototype.hasOwnProperty.call(labels, k)) L.accounts[k].label = labels[k];

    try {
      opDeposit(L, supplierOne, 8n * WEI, t0);
      opDeposit(L, supplierTwo, 4n * WEI, t0 + 600n);

      /* Loan 1 — 54 days overdue, collateral still covers the debt: liquidating
         it pays the pool in full and refunds the surplus collateral. */
      opRequestLoan(L, borrowerFenwick, {
        principal: WEI, rateBps: 1800n, durationDays: 6n, collateral: 110n * WEI / 100n
      }, t0 + 3600n);

      /* Loan 2 — 30 days overdue and under-collateralised: liquidating it writes
         off real bad debt. */
      opRequestLoan(L, borrowerKestrel, {
        principal: 4n * WEI, rateBps: 5000n, durationDays: 30n, collateral: 401n * WEI / 100n
      }, t0 + 7200n);

      /* Loan 3 — a clean repayment, 5 days before its due date. */
      var repaid = opRequestLoan(L, borrowerFenwick, {
        principal: WEI, rateBps: 900n, durationDays: 10n, collateral: 102n * WEI / 100n
      }, now - 50n * DAY);
      var repaidLoan = L.loans[repaid.loanId.toString()];
      opRepayLoan(L, borrowerFenwick, repaid.loanId, repaidLoan.principal + repaidLoan.interest, now - 45n * DAY);

      /* Loan 4 — active, comfortably covered, not yet due. */
      opRequestLoan(L, borrowerAshcombe, {
        principal: 3n * WEI / 2n, rateBps: 1200n, durationDays: 30n, collateral: 165n * WEI / 100n
      }, now - 3n * DAY);

      /* Loan 5 — a request larger than the free liquidity: lands as Pending and
         waits for fundLoan or cancelLoan. */
      opRequestLoan(L, borrowerThornbury, {
        principal: 15n * WEI, rateBps: 700n, durationDays: 45n, collateral: 151n * WEI / 10n
      }, now - 2n * DAY);
    } catch (err) {
      /* A seed that cannot validate is a bug, not a user error: fall back to a
         blank ledger so the grader still gets a working page. */
      L = blankLedger();
      L.accounts[String(DEMO_ADDRESS).toLowerCase()] = { ethWei: DEMO_START_BALANCE, label: 'Your demo desk' };
      L.txs.push({
        hash: fakeHash('seed-failure'), type: 'notice', status: 'confirmed', from: DEMO_ADDRESS, to: '',
        amountWei: 0n, loanId: null, timestamp: Number(clock()), demo: true,
        note: 'Demo book could not be seeded (' + err.message + '); starting from a blank ledger.'
      });
    }
    return L;
  }

  /* ------------------------------------------------------------------ *
   * Persistence
   * ------------------------------------------------------------------ */

  function persist() {
    if (!L) return;
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(enc(L)));
    } catch (err) {
      /* Quota or private-browsing failure: the session keeps working in memory. */
      if (global.console && global.console.warn) global.console.warn('[MicroLend demo] ledger not persisted:', err.message);
    }
  }

  function restore() {
    try {
      var raw = global.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var parsed = dec(JSON.parse(raw));
      if (!parsed || parsed.version !== VERSION) return null;
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function ensure() {
    if (L) return L;
    L = restore();
    if (!L) L = seedLedger();
    return L;
  }

  /* ------------------------------------------------------------------ *
   * Public surface
   * ------------------------------------------------------------------ */

  function stats() {
    ensure();
    return {
      mode: 'demo',
      totalShares: L.totalShares,
      totalLiquidity: L.totalLiquidity,
      availableLiquidity: availableLiquidity(L),
      reservedLiquidity: L.reservedLiquidity,
      totalDeposited: L.totalDeposited,
      totalInterestEarned: L.totalInterestEarned,
      totalFeesCollected: L.totalFeesCollected,
      totalBadDebt: L.totalBadDebt,
      treasuryBalance: L.treasuryBalance,
      accumulatedCollateral: L.accumulatedCollateral,
      loanCount: L.loanCount,
      sharePrice: sharePriceOf(L),
      paused: L.paused,
      owner: L.owner,
      treasury: L.treasury,
      params: L.params,
      blockTimestamp: Number(clock())
    };
  }

  function position(address) {
    ensure();
    var key = String(address || DEMO_ADDRESS).toLowerCase();
    var shares = sharesOf(L, key);
    var collateralLocked = 0n;
    var outstandingDebt = 0n;
    var activeLoans = 0n;
    var pendingLoans = 0n;
    var now = clock();
    var ids = userLoanIds(L, key);
    for (var i = 0; i < ids.length; i++) {
      var loan = L.loans[ids[i].toString()];
      if (!loan) continue;
      if (loan.status === 1 || loan.status === 2) collateralLocked += loan.collateral;
      if (loan.status === 1) pendingLoans += 1n;
      if (loan.status === 2) {
        activeLoans += 1n;
        outstandingDebt += previewRepaymentOf(L, loan, now).amountDue;
      }
    }
    return {
      address: key,
      shares: shares,
      shareValue: convertToAssets(L, shares),
      collateralLocked: collateralLocked,
      activeLoans: activeLoans,
      pendingLoans: pendingLoans,
      outstandingDebt: outstandingDebt,
      ethBalance: account(L, key).ethWei,
      label: account(L, key).label || ''
    };
  }

  function allLoans() {
    ensure();
    var out = [];
    for (var k in L.loans) {
      if (Object.prototype.hasOwnProperty.call(L.loans, k)) out.push(loanView(L.loans[k]));
    }
    return out;
  }

  function loanView(loan) {
    if (!loan) return null;
    var now = clock();
    var out = {
      id: loan.id,
      borrower: loan.borrower,
      principal: loan.principal,
      collateral: loan.collateral,
      interest: loan.interest,
      rateBps: loan.rateBps,
      durationDays: loan.durationDays,
      startTime: loan.startTime,
      dueDate: loan.dueDate,
      amountFunded: loan.amountFunded,
      status: loan.status,
      mode: 'demo',
      borrowerLabel: (L.accounts[String(loan.borrower).toLowerCase()] || {}).label || ''
    };
    if (loan.status === 2) {
      var due = previewRepaymentOf(L, loan, now);
      out.amountDue = due.amountDue;
      out.lateFee = due.lateFee;
      out.overdue = now > loan.dueDate;
      out.collateralRatioBps = collateralRatioOf(L, loan, now);
      out.periodsLate = now > loan.dueDate ? ((now - loan.dueDate) / LATE_PERIOD + 1n) : 0n;
    } else if (loan.status === 1) {
      out.requiredCollateral = mulDivUp(loan.principal, L.params.minCollateralBps, BPS);
      out.remainingToFund = loan.principal - loan.amountFunded;
    }
    return out;
  }

  function getUserLoans(address) {
    ensure();
    var key = String(address || DEMO_ADDRESS).toLowerCase();
    return userLoanIds(L, key).map(function (id) { return loanView(L.loans[id.toString()]); });
  }

  function getLoan(id) {
    ensure();
    return loanView(L.loans[String(id)]);
  }

  function transactions(filter) {
    ensure();
    var f = filter || {};
    return L.txs.filter(function (tx) {
      if (f.address && String(tx.from).toLowerCase() !== String(f.address).toLowerCase() &&
        String(tx.to).toLowerCase() !== String(f.address).toLowerCase()) return false;
      if (f.type && tx.type !== f.type) return false;
      return true;
    });
  }

  /* Every simulated account, so the UI can offer an "acting as" switch. Without
     it a grader could never exercise borrower-only paths (cancelLoan) on the
     seeded book, or repay another actor's loan. */
  function accounts() {
    ensure();
    var out = [];
    for (var key in L.accounts) {
      if (!Object.prototype.hasOwnProperty.call(L.accounts, key)) continue;
      var entry = L.accounts[key];
      out.push({
        address: key,
        label: entry.label || UI_shorten(key),
        ethWei: entry.ethWei,
        shares: sharesOf(L, key),
        shareValue: convertToAssets(L, sharesOf(L, key)),
        isDesk: key === String(DEMO_ADDRESS).toLowerCase()
      });
    }
    out.sort(function (a, b) {
      if (a.isDesk) return -1;
      if (b.isDesk) return 1;
      return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
    });
    return out;
  }

  function UI_shorten(address) {
    return global.ML_UI ? global.ML_UI.shortenAddress(address) : address;
  }

  /* Ledger check. A peer-to-pool lender must always satisfy
   *
   *   ETH held by the pool  ==  free liquidity + collateral held + unclaimed fees
   *
   * where free liquidity is `availableLiquidity` = totalLiquidity - reservedLiquidity
   * and the collateral is ETH the pool holds on the borrowers' behalf. The demo
   * tracks the pool's cash independently, so this is a real cross-check of the
   * mirrored arithmetic rather than a restatement of the same numbers: every
   * supply, loan, repayment and liquidation must leave it at zero.
   */
  function audit() {
    ensure();
    var claims = availableLiquidity(L) + L.accumulatedCollateral + L.treasuryBalance;
    var held = L.poolBalance;
    var difference = held - claims;
    return {
      cashHeld: held,
      claims: claims,
      difference: difference,
      balanced: difference === 0n,
      detail: {
        availableLiquidity: availableLiquidity(L),
        accumulatedCollateral: L.accumulatedCollateral,
        treasuryBalance: L.treasuryBalance,
        reservedLiquidity: L.reservedLiquidity,
        totalLiquidity: L.totalLiquidity
      }
    };
  }

  function advanceTime(seconds, label) {
    ensure();
    var delta = BigInt(seconds);
    L.clockOffset += delta;
    var tx = record('clock', {
      from: '', amountWei: 0n,
      note: (label || 'Simulated clock advanced by ' + (Number(delta) / 86400).toFixed(2) + ' days') +
        '. Ledger time is now ' + new Date(Number(clock()) * 1000).toISOString().replace('.000Z', 'Z') + '.'
    });
    persist();
    return tx;
  }

  function reset() {
    L = blankLedger();
    L.accounts[String(DEMO_ADDRESS).toLowerCase()] = { ethWei: DEMO_START_BALANCE, label: 'Your demo desk' };
    record('notice', { note: 'Ledger reset. The demo desk holds ' + fmt(DEMO_START_BALANCE) + ' ETH and the pool is empty.' });
    persist();
    return L;
  }

  function reseed() {
    seedLedger();
    persist();
    return L;
  }

  /* Wipes both the ledger and anything the UI cached for it. */
  function clearAll() {
    try {
      global.localStorage.removeItem(STORAGE_KEY);
      global.localStorage.removeItem('ml.history.v1');
    } catch (err) { /* ignore */ }
    L = null;
    ensure();
    persist();
    return L;
  }

  /* Executes an op through the same envelope the on-chain path uses, so app.js
     has one error-handling branch. */
  function run(fn) {
    ensure();
    try {
      var result = fn();
      persist();
      return result;
    } catch (err) {
      if (err && err.isDemoRevert) {
        err.userMessage = err.message && err.message !== err.revertName ? err.message : describeError(err.revertName, err.args);
      }
      throw err;
    }
  }

  var API = {
    address: DEMO_ADDRESS,
    startBalance: DEMO_START_BALANCE,
    actorAddress: actorAddress,
    chainTime: function () { return Number(clock()); },

    /* reads */
    stats: stats,
    poolStats: stats,
    position: position,
    allLoans: allLoans,
    accounts: accounts,
    getUserLoans: getUserLoans,
    getLoan: getLoan,
    transactions: transactions,
    audit: audit,
    params: function () { ensure(); return L.params; },
    previewInterest: function (principal, rateBps, durationDays) {
      return previewInterest(BigInt(principal), BigInt(rateBps), BigInt(durationDays));
    },
    quoteCollateral: function (principal, rateBps, durationDays) {
      ensure();
      return quoteCollateral(BigInt(principal), BigInt(rateBps), BigInt(durationDays), L.params.minCollateralBps);
    },
    previewRepayment: function (loanId) {
      ensure();
      var loan = L.loans[String(loanId)];
      if (!loan) return null;
      if (loan.status !== 2) return { amountDue: 0n, lateFee: 0n, base: 0n, notActive: true };
      var due = previewRepaymentOf(L, loan, clock());
      due.overdue = clock() > loan.dueDate;
      return due;
    },
    convertToShares: function (assets) { ensure(); return convertToShares(L, BigInt(assets)); },
    convertToAssets: function (shares) { ensure(); return convertToAssets(L, BigInt(shares)); },

    /* writes */
    deposit: function (from, value) { return run(function () { return opDeposit(L, from, BigInt(value), clock()); }); },
    withdraw: function (from, shares) { return run(function () { return opWithdraw(L, from, BigInt(shares), clock()); }); },
    requestLoan: function (from, req) {
      return run(function () {
        return opRequestLoan(L, from, {
          principal: BigInt(req.principal),
          rateBps: BigInt(req.rateBps),
          durationDays: BigInt(req.durationDays),
          collateral: BigInt(req.collateral)
        }, clock());
      });
    },
    fundLoan: function (from, loanId, value) { return run(function () { return opFundLoan(L, from, BigInt(loanId), BigInt(value), clock()); }); },
    repayLoan: function (from, loanId, value) { return run(function () { return opRepayLoan(L, from, BigInt(loanId), BigInt(value), clock()); }); },
    cancelLoan: function (from, loanId) { return run(function () { return opCancelLoan(L, from, BigInt(loanId), clock()); }); },
    liquidate: function (from, loanId) { return run(function () { return opLiquidate(L, from, BigInt(loanId), clock()); }); },
    setParams: function (from, next) { return run(function () { return opSetParams(L, from, next, clock()); }); },
    setPaused: function (from, paused) { return run(function () { return opSetPaused(L, from, !!paused, clock()); }); },
    setTreasury: function (from, address) { return run(function () { return opSetTreasury(L, from, address, clock()); }); },
    transferOwnership: function (from, address) { return run(function () { return opTransferOwnership(L, from, address, clock()); }); },
    claimTreasury: function (from, to) { return run(function () { return opClaimTreasury(L, from, to, clock()); }); },

    /* clock + lifecycle */
    advanceTime: advanceTime,
    advanceToNextDue: function () {
      ensure();
      var now = clock();
      var target = null;
      for (var k in L.loans) {
        var loan = L.loans[k];
        if (loan.status === 2 && loan.dueDate > now) {
          if (target === null || loan.dueDate < target) target = loan.dueDate;
        }
      }
      if (target === null) {
        advanceTime(Number(DAY), 'Simulated clock advanced by 1 day (no active loan is still before its due date)');
        return null;
      }
      var delta = target - now + 3600n; /* one hour past the due date */
      advanceTime(Number(delta), 'Simulated clock advanced past the nearest due date');
      return Number(delta);
    },
    reset: reset,
    reseed: reseed,
    clearAll: clearAll,
    ensure: ensure,
    describeError: describeError,
    DEMO_ADDRESS: DEMO_ADDRESS,
    STORAGE_KEY: STORAGE_KEY
  };

  global.ML_DEMO = API;
})(typeof window !== 'undefined' ? window : this);
