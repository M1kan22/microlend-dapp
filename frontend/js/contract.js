/* MicroLend — pool contract access via ethers v6.
 *
 * Reads use a provider so the dashboard works even before connecting; writes use
 * the wallet signer, and every write is pre-flighted with `staticCall` (a real
 * eth_call against current state) and then gas-estimated before a transaction is
 * sent. Custom errors from the contract are decoded through the ABI and turned
 * into the same human sentences the demo ledger produces, so the UI never shows
 * a bare "execution reverted".
 *
 * ethers is loaded from vendor/ethers.umd.min.js (CDN fallback in index.html).
 * The app degrades to demo mode if it is unavailable — contract.js reports that
 * honestly instead of throwing.
 */
(function (global) {
  'use strict';

  var STATUS = ['None', 'Pending', 'Active', 'Repaid', 'Liquidated', 'Cancelled'];
  var STATUS_ORDER = { Pending: 1, Active: 2, Repaid: 3, Liquidated: 4, Cancelled: 5 };

  var cache = {
    provider: null,
    providerKey: '',
    readContract: null,
    signer: null,
    contract: null,
    address: '',
    abi: null
  };

  function ethersLib() {
    return global.ethers || null;
  }

  function abi() {
    return global.ML_CONTRACT_ABI || [];
  }

  function available() {
    return !!ethersLib();
  }

  function hasAddress() {
    return global.ML_CONFIG.hasContract();
  }

  function reason() {
    if (!available()) {
      return global.__ML_ETHERS_LOCAL_FAILED && global.__ML_ETHERS_CDN_FAILED
        ? 'The ethers library could not be loaded from vendor/ or the CDN, so on-chain reads are unavailable. Demo mode still works.'
        : 'The ethers library is not loaded, so on-chain reads are unavailable. Demo mode still works.';
    }
    if (!hasAddress()) return 'No pool contract address is configured. Set one under Connection to read the chain.';
    if (!abi().length) return 'The pool ABI is missing (js/abi.js).';
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Provider / contract construction
   * ------------------------------------------------------------------ */

  function readProvider() {
    var ethers = ethersLib();
    if (!ethers) throw new Error(reason());
    var wallet = global.ML_WALLET && global.ML_WALLET.injected && global.ML_WALLET.injected();
    var key = wallet ? 'wallet' : (global.ML_CONFIG.rpcUrl || '');
    if (cache.provider && cache.providerKey === key) return cache.provider;
    if (wallet) {
      cache.provider = new ethers.BrowserProvider(wallet);
    } else if (global.ML_CONFIG.rpcUrl) {
      cache.provider = new ethers.JsonRpcProvider(global.ML_CONFIG.rpcUrl);
    } else {
      throw new Error('No wallet and no read-only RPC URL are configured.');
    }
    cache.providerKey = key;
    cache.readContract = null;
    return cache.provider;
  }

  function readContract() {
    var ethers = ethersLib();
    if (!ethers) throw new Error(reason());
    if (!hasAddress()) throw new Error(reason());
    if (cache.readContract && cache.address === global.ML_CONFIG.contractAddress) return cache.readContract;
    cache.readContract = new ethers.Contract(global.ML_CONFIG.contractAddress, abi(), readProvider());
    cache.address = global.ML_CONFIG.contractAddress;
    return cache.readContract;
  }

  function writeContext() {
    var ethers = ethersLib();
    if (!ethers) throw new Error(reason());
    if (!hasAddress()) throw new Error(reason());
    if (!global.ML_WALLET || !global.ML_WALLET.address()) {
      throw new Error('Connect a wallet before sending a transaction.');
    }
    var wallet = global.ML_WALLET.injected();
    var provider = new ethers.BrowserProvider(wallet);
    return provider.getSigner().then(function (signer) {
      return {
        signer: signer,
        contract: new ethers.Contract(global.ML_CONFIG.contractAddress, abi(), signer)
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * Error decoding
   * ------------------------------------------------------------------ */

  function revertData(err) {
    if (!err) return null;
    if (typeof err.data === 'string' && /^0x[0-9a-f]+$/i.test(err.data)) return err.data;
    if (err.info && typeof err.info.error === 'object' && err.info.error && typeof err.info.error.data === 'string') {
      return err.info.error.data;
    }
    if (err.error && typeof err.error.data === 'string') return err.error.data;
    if (err.revert && err.revert.name) return null;
    return null;
  }

  function decodeRevert(err) {
    var ethers = ethersLib();
    if (err && err.revert && err.revert.name) {
      var args = {};
      (err.revert.args || []).forEach(function (value, index) {
        args['arg' + index] = value;
      });
      return { name: err.revert.name, args: args };
    }
    var data = revertData(err);
    if (!data || !ethers || !abi().length) return null;
    try {
      var iface = new ethers.Interface(abi());
      var parsed = iface.parseError(data);
      if (!parsed) return null;
      var named = {};
      if (parsed.fragment && parsed.fragment.inputs) {
        parsed.fragment.inputs.forEach(function (input, index) {
          named[input.name || 'arg' + index] = parsed.args[index];
        });
      }
      return { name: parsed.name, args: named };
    } catch (parseErr) {
      return null;
    }
  }

  /* Field names differ from the demo's (which uses the Solidity parameter
     names); normalise so ML_UI.revertMessage can format both. */
  function normaliseArgs(name, args) {
    var a = args || {};
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    if (JSON.stringify(Object.keys(a)) === JSON.stringify(['arg0', 'arg1'])) {
      if (name === 'AmountTooSmall') { out.provided = a.arg0; out.minimum = a.arg1; }
      else if (name === 'AmountTooLarge') { out.provided = a.arg0; out.maximum = a.arg1; }
      else if (name === 'DurationInvalid') { out.provided = a.arg0; out.maximum = a.arg1; }
      else if (name === 'RateTooHigh') { out.provided = a.arg0; out.maximum = a.arg1; }
      else if (name === 'InsufficientCollateral') { out.provided = a.arg0; out.required = a.arg1; }
      else if (name === 'InsufficientLiquidity') { out.requested = a.arg0; out.available = a.arg1; }
      else if (name === 'InsufficientPayment') { out.provided = a.arg0; out.required = a.arg1; }
      else if (name === 'InsufficientShares') { out.provided = a.arg0; out.owned = a.arg1; }
      else if (name === 'NotFunded') { out.funded = a.arg0; out.principal = a.arg1; }
      else if (name === 'NotBorrower') { out.caller = a.arg0; }
      else if (name === 'InvalidParameter') { out.name = String(a.arg0); }
      else if (name === 'InvalidLoan' || name === 'LoanNotPending' || name === 'LoanNotActive' || name === 'LoanNotOverdue') {
        out.loanId = String(a.arg0);
      }
    }
    return out;
  }

  function humanError(err) {
    var decoded = decodeRevert(err);
    if (decoded && global.ML_UI) {
      return global.ML_UI.revertMessage(decoded.name, normaliseArgs(decoded.name, decoded.args));
    }
    var code = err && (err.code || (err.info && err.info.error && err.info.error.code));
    if (code === 4001 || code === 'ACTION_REJECTED') {
      return 'The transaction was rejected in the wallet. Nothing was sent.';
    }
    if (code === 'INSUFFICIENT_FUNDS') {
      return 'The wallet does not hold enough ETH to cover this transaction plus gas.';
    }
    if (code === 'NETWORK_ERROR') {
      return 'The wallet could not reach the network. Check the RPC endpoint in MetaMask.';
    }
    if (err && err.shortMessage) return err.shortMessage;
    return (err && err.message) || 'The transaction could not be completed.';
  }

  function wrap(err) {
    var out = new Error(humanError(err));
    out.name = 'ContractError';
    out.original = err;
    var decoded = decodeRevert(err);
    if (decoded) out.revertName = decoded.name;
    return out;
  }

  /* ------------------------------------------------------------------ *
   * Reads
   * ------------------------------------------------------------------ */

  function poolStats() {
    return readContract().poolStats().then(function (r) {
      var ethers = ethersLib();
      void ethers;
      return {
        mode: 'chain',
        totalShares: BigInt(r[0]),
        totalLiquidity: BigInt(r[1]),
        availableLiquidity: BigInt(r[2]),
        reservedLiquidity: BigInt(r[3]),
        totalDeposited: BigInt(r[4]),
        totalInterestEarned: BigInt(r[5]),
        totalFeesCollected: BigInt(r[6]),
        totalBadDebt: BigInt(r[7]),
        treasuryBalance: BigInt(r[8]),
        loanCount: BigInt(r[9]),
        sharePrice: BigInt(r[10]),
        paused: !!r[11],
        params: null,
        blockTimestamp: Math.floor(Date.now() / 1000)
      };
    }, function (err) { throw wrap(err); });
  }

  function params() {
    var c = readContract();
    var names = ['minDeposit', 'minLoanPrincipal', 'maxLoanPrincipal', 'maxDurationDays',
      'maxRateBps', 'minCollateralBps', 'feeBps', 'penaltyBps', 'lateFeeBps'];
    return Promise.all(names.map(function (n) { return c[n](); })).then(function (values) {
      var out = {};
      names.forEach(function (n, i) { out[n] = BigInt(values[i]); });
      return out;
    }, function (err) { throw wrap(err); });
  }

  function owner() {
    return readContract().owner().then(function (v) { return v; }, function (err) { throw wrap(err); });
  }

  function treasury() {
    return readContract().treasury().then(function (v) { return v; }, function (err) { throw wrap(err); });
  }

  function sharesOf(address) {
    return readContract().sharesOf(address).then(function (v) { return BigInt(v); }, function (err) { throw wrap(err); });
  }

  function position(address) {
    return readContract().getUserPosition(address).then(function (r) {
      return {
        address: address,
        shares: BigInt(r[0]),
        shareValue: BigInt(r[1]),
        collateralLocked: BigInt(r[2]),
        activeLoans: BigInt(r[3]),
        pendingLoans: BigInt(r[4]),
        outstandingDebt: BigInt(r[5]),
        ethBalance: 0n,
        label: ''
      };
    }, function (err) { throw wrap(err); });
  }

  function normaliseLoan(raw) {
    var status = Number(raw.status !== undefined ? raw.status : raw[10]);
    var loan = {
      id: BigInt(raw.id !== undefined ? raw.id : raw[0]),
      borrower: raw.borrower !== undefined ? raw.borrower : raw[1],
      principal: BigInt(raw.principal !== undefined ? raw.principal : raw[2]),
      collateral: BigInt(raw.collateral !== undefined ? raw.collateral : raw[3]),
      interest: BigInt(raw.interest !== undefined ? raw.interest : raw[4]),
      rateBps: BigInt(raw.rateBps !== undefined ? raw.rateBps : raw[5]),
      durationDays: BigInt(raw.durationDays !== undefined ? raw.durationDays : raw[6]),
      startTime: BigInt(raw.startTime !== undefined ? raw.startTime : raw[7]),
      dueDate: BigInt(raw.dueDate !== undefined ? raw.dueDate : raw[8]),
      amountFunded: BigInt(raw.amountFunded !== undefined ? raw.amountFunded : raw[9]),
      status: status,
      statusName: STATUS[status] || 'Unknown',
      mode: 'chain',
      borrowerLabel: ''
    };
    loan.remainingToFund = loan.status === 1 ? loan.principal - loan.amountFunded : 0n;
    return loan;
  }

  function getLoan(id) {
    return readContract().getLoan(id).then(function (r) {
      return normaliseLoan(r);
    }, function (err) { throw wrap(err); });
  }

  function userLoanIds(address) {
    return readContract().getUserLoans(address).then(function (ids) {
      return Array.from(ids).map(function (v) { return BigInt(v); });
    }, function (err) { throw wrap(err); });
  }

  function loansOf(address) {
    return userLoanIds(address).then(function (ids) {
      var results = [];
      var queue = ids.slice();
      function next() {
        if (!queue.length) return Promise.resolve();
        var id = queue.shift();
        return getLoan(id).then(function (loan) {
          results.push(loan);
          return next();
        }, function () { return next(); });
      }
      /* Small concurrency so a long book does not open 200 RPC calls at once. */
      var workers = [];
      for (var i = 0; i < Math.min(6, ids.length); i++) workers.push(next());
      return Promise.all(workers).then(function () {
        results.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
        return results;
      });
    });
  }

  function previewRepayment(id) {
    return readContract().previewRepayment(id).then(function (r) {
      return { amountDue: BigInt(r[0]), lateFee: BigInt(r[1]), base: BigInt(r[0]) - BigInt(r[1]) };
    }, function (err) { throw wrap(err); });
  }

  function isOverdue(id) {
    return readContract().isOverdue(id).then(function (v) { return !!v; }, function () { return false; });
  }

  /* Local quote maths, identical to the contract's pure functions — used for the
     live borrow quote so it updates as the user types without an RPC round trip. */
  function previewInterest(principal, rateBps, durationDays) {
    var p = BigInt(principal), r = BigInt(rateBps), d = BigInt(durationDays);
    return (p * r * d) / (10000n * 365n);
  }

  function quoteCollateral(principal, rateBps, durationDays, minCollateralBps) {
    var p = BigInt(principal);
    var bps = BigInt(minCollateralBps === undefined || minCollateralBps === null ? 10000n : minCollateralBps);
    var product = p * bps;
    return {
      requiredCollateral: product === 0n ? 0n : (product + 10000n - 1n) / 10000n,
      totalDue: p + previewInterest(principal, rateBps, durationDays)
    };
  }

  /* ------------------------------------------------------------------ *
   * Writes
   * ------------------------------------------------------------------ */

  /* Simulate, estimate, then send. `opts.simulate === false` skips the
     pre-flight (owner calls that depend on fresh state, for example). */
  function send(fnName, args, overrides, opts) {
    var o = opts || {};
    return writeContext().then(function (ctx) {
      var fn = ctx.contract[fnName];
      if (typeof fn !== 'function') throw new Error('The ABI does not define ' + fnName + '().');

      var preflight = o.simulate === false
        ? Promise.resolve()
        : fn.staticCall.apply(fn, args.concat([overrides])).catch(function (err) {
          throw wrap(err);
        });

      return preflight.then(function () {
        return fn.estimateGas.apply(fn, args.concat([overrides])).then(function (estimate) {
          return (BigInt(estimate) * 120n) / 100n;
        }, function () {
          return undefined; /* estimation may fail for owner-only paths; let the wallet decide */
        });
      }).then(function (gasLimit) {
        var txOverrides = Object.assign({}, overrides);
        if (gasLimit) txOverrides.gasLimit = gasLimit;
        return fn.apply(fn, args.concat([txOverrides]));
      }).then(function (tx) {
        return {
          hash: tx.hash,
          explorerUrl: global.ML_CONFIG.explorerTx(tx.hash),
          wait: function (confirmations) {
            return tx.wait(confirmations === undefined ? 1 : confirmations);
          }
        };
      }, function (err) {
        if (err && err.name === 'ContractError') throw err;
        throw wrap(err);
      });
    });
  }

  function ethToWei(ethString) {
    var parsed = global.ML_UI.parseEthToWei(ethString);
    if (!parsed.ok) throw new Error(parsed.reason);
    return parsed.wei;
  }

  var WRITE = {
    deposit: function (ethAmount) {
      return send('deposit', [], { value: ethToWei(ethAmount) });
    },
    withdraw: function (shares) {
      return send('withdraw', [BigInt(shares)], {});
    },
    requestLoan: function (input) {
      return send('requestLoan', [BigInt(input.principal), BigInt(input.rateBps), BigInt(input.durationDays)],
        { value: BigInt(input.collateral) });
    },
    fundLoan: function (loanId, ethAmount) {
      return send('fundLoan', [BigInt(loanId)], { value: ethToWei(ethAmount) });
    },
    repayLoan: function (loanId, ethAmount) {
      return send('repayLoan', [BigInt(loanId)], { value: ethToWei(ethAmount) });
    },
    cancelLoan: function (loanId) {
      return send('cancelLoan', [BigInt(loanId)], {});
    },
    liquidate: function (loanId) {
      return send('liquidate', [BigInt(loanId)], {});
    },
    setParams: function (p) {
      return send('setParams', [
        BigInt(p.minDeposit), BigInt(p.minLoanPrincipal), BigInt(p.maxLoanPrincipal),
        BigInt(p.maxDurationDays), BigInt(p.maxRateBps), BigInt(p.minCollateralBps),
        BigInt(p.feeBps), BigInt(p.penaltyBps), BigInt(p.lateFeeBps)
      ], {});
    },
    setPaused: function (paused) {
      return send('setPaused', [!!paused], {});
    },
    setTreasury: function (address) {
      return send('setTreasury', [address], {});
    },
    transferOwnership: function (address) {
      return send('transferOwnership', [address], {});
    },
    claimTreasury: function (to) {
      return send('claimTreasury', [to], {});
    }
  };

  global.ML_CONTRACT = {
    available: available,
    reason: reason,
    STATUS: STATUS,
    STATUS_ORDER: STATUS_ORDER,
    poolStats: poolStats,
    params: params,
    owner: owner,
    treasury: treasury,
    sharesOf: sharesOf,
    position: position,
    getLoan: getLoan,
    loansOf: loansOf,
    userLoanIds: userLoanIds,
    previewRepayment: previewRepayment,
    isOverdue: isOverdue,
    previewInterest: previewInterest,
    quoteCollateral: quoteCollateral,
    normaliseLoan: normaliseLoan,
    humanError: humanError,
    decodeRevert: decodeRevert,
    WRITE: WRITE,
    resetCache: function () {
      cache.provider = null;
      cache.providerKey = '';
      cache.readContract = null;
      cache.address = '';
    }
  };
})(typeof window !== 'undefined' ? window : this);
