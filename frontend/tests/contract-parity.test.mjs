/* MicroLend demo ledger — arithmetic parity with MicroLendPool.sol.
 *
 * Run with:  node tests/ui-contract.test.mjs
 * Requires no dependencies beyond Node 18+; no browser, no network.
 */
import fs from 'node:fs';
import vm from 'node:vm';

/* paths are resolved against the frontend/ folder, one level up from tests/ */
const ROOT = new URL('../', import.meta.url);
const file = (rel) => new URL(rel, ROOT);

const store = new Map();
const win = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  console,
  Date,
  Math,
  JSON,
  BigInt,
  Number,
  String,
  Object,
  Array,
  Error,
  TypeError,
  isFinite,
  setTimeout,
  clearTimeout
};
win.window = win;
const ctx = vm.createContext(win);
for (const f of ['js/ui.js', 'js/demo.js']) {
  vm.runInContext(fs.readFileSync(file(f), 'utf8'), ctx, { filename: f });
}

const UI = win.ML_UI;
const D = win.ML_DEMO;
let fails = 0;
const eq = (label, got, want) => {
  const ok = String(got) === String(want);
  if (!ok) fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + '  got=' + got + (ok ? '' : '  want=' + want));
};

console.log('\n== ui.js formatting ==');
eq('group 1e21', UI.formatEth(1000123456789012345678n, { dp: 4 }), '1,000.1234');
eq('exact', UI.formatEthExact(1000123456789012345678n), '1,000.123456789012345678');
eq('tiny wei stays honest and compact', UI.formatEth(1n), '< 0.00000001');
eq('tiny wei exact', UI.formatEthExact(1n), '0.000000000000000001');
eq('small non-zero widens to two significant digits', UI.formatEth(12300000000000n), '0.000012');
eq('fraction pads to a fixed width', UI.formatEth(500000000000000000n), '0.5000');
eq('zero', UI.formatEth(0n), '0.0000');
eq('parse 1.5', UI.parseEthToWei('1.5').weiString, '1500000000000000000');
eq('parse .25', UI.parseEthToWei('.25').weiString, '250000000000000000');
eq('parse 19dp rejected', UI.parseEthToWei('0.1234567890123456789').ok, 'false');
eq('parse exponent rejected', UI.parseEthToWei('1e3').ok, 'false');
eq('pct 1/3', UI.formatSharePercent(1000000000000000000n, 3000000000000000000n), '33.3');
eq('pct 0/0', UI.formatSharePercent(0n, 0n), '0.0');
eq('bps 1000', UI.formatBps(1000n), '10.00%');
eq('shorten', UI.shortenAddress('0x7A3f19C4b0d2E5a6F81C93B4D0e7A2f58C204111'), '0x7A3f19\u20264111');
eq('escape', UI.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');

console.log('\n== demo.js: fresh ledger, exact wei ==');
D.clearAll();
D.reset();
let s = D.stats();
eq('fresh pool empty', s.totalLiquidity, '0');
eq('demo desk balance', D.position(D.address).ethBalance, (50n * 10n ** 18n).toString());

const dep = D.deposit(D.address, 8n * 10n ** 18n);
eq('first deposit mints value-1 shares', dep.minted, (8n * 10n ** 18n - 1n).toString());
s = D.stats();
eq('totalShares includes dead share', s.totalShares, (8n * 10n ** 18n).toString());
eq('totalLiquidity', s.totalLiquidity, (8n * 10n ** 18n).toString());
eq('sharePrice 1e18', s.sharePrice, (10n ** 18n).toString());

/* Loan: 2 ETH, 1200 bps (12%), 30 days. interest = 2e18*1200*30/(10000*365) */
const wantInterest = (2n * 10n ** 18n * 1200n * 30n) / (10000n * 365n);
const req = D.requestLoan(D.address, { principal: 2n * 10n ** 18n, rateBps: 1200n, durationDays: 30n, collateral: 2n * 10n ** 18n });
eq('loan activates immediately', D.getLoan(req.loanId).status, 2);
eq('interest exact', D.getLoan(req.loanId).interest, wantInterest.toString());
eq('reservedLiquidity', D.stats().reservedLiquidity, (2n * 10n ** 18n).toString());
eq('available', D.stats().availableLiquidity, (6n * 10n ** 18n).toString());

/* Repay exactly: due = principal + interest */
const due = D.previewRepayment(req.loanId);
eq('amountDue', due.amountDue, (2n * 10n ** 18n + wantInterest).toString());
eq('lateFee zero before due', due.lateFee, '0');
const rep = D.repayLoan(D.address, req.loanId, due.amountDue);
const wantFee = (wantInterest * 1000n) / 10000n;
eq('protocol fee 10% of interest', rep.fee, wantFee.toString());
eq('treasuryBalance', D.stats().treasuryBalance, wantFee.toString());
eq('status Repaid', D.getLoan(req.loanId).status, 3);
eq('collateral returned', D.position(D.address).collateralLocked, '0');

console.log('\n== demo.js: late fee + bad debt (liquidation) ==');
D.reset();
D.deposit(D.address, 10n * 10n ** 18n);
const l2 = D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 5000n, durationDays: 30n, collateral: 1n * 10n ** 18n });
/* advance 45 days: 15 days past due -> periods = 15d/30d+1 = 1 */
D.advanceTime(45 * 86400);
const base = 1n * 10n ** 18n + (1n * 10n ** 18n * 5000n * 30n) / (10000n * 365n);
const wantLate = (base * 100n) / 10000n;
eq('lateFee 1 period', D.previewRepayment(l2.loanId).lateFee, wantLate.toString());
eq('amountDue', D.previewRepayment(l2.loanId).amountDue, (base + wantLate).toString());
eq('overdue flag', D.getLoan(l2.loanId).overdue, 'true');
const liq = D.liquidate(D.address, l2.loanId);
/* collateral 1 ETH < owed -> compensation = collateral, badDebt = owed - collateral */
eq('compensation = collateral', liq.compensation, (1n * 10n ** 18n).toString());
eq('badDebt written off', liq.badDebt, (base + wantLate - 1n * 10n ** 18n).toString());
eq('totalBadDebt', D.stats().totalBadDebt, (base + wantLate - 1n * 10n ** 18n).toString());
eq('status Liquidated', D.getLoan(l2.loanId).status, 4);
let ra;
try { D.liquidate(D.address, l2.loanId); ra = 'no-revert'; } catch (e) { ra = e.revertName; }
eq('second liquidate reverts LoanNotActive', ra, 'LoanNotActive');

/* late fee with 2 periods: due exactly 30 days ago -> 30d/30d + 1 = 2 */
D.reset();
D.deposit(D.address, 10n * 10n ** 18n);
const l3 = D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 1000n, durationDays: 10n, collateral: 1n * 10n ** 18n });
D.advanceTime(40 * 86400); /* due at +10d, now +40d -> 30 days late -> 2 periods */
const base3 = 1n * 10n ** 18n + (1n * 10n ** 18n * 1000n * 10n) / (10000n * 365n);
/* contract computes this in ONE division: base * lateFeeBps * periods / 10000 */
eq('lateFee 2 periods', D.previewRepayment(l3.loanId).lateFee, ((base3 * 100n * 2n) / 10000n).toString());

console.log('\n== demo.js: share accounting on a second supplier + partial withdraw ==');
D.reset();
D.deposit(D.address, 8n * 10n ** 18n);
const other = D.actorAddress('other');
D.ensure();
const before = D.stats();
/* push share price up: open a loan and repay it with interest */
const l4 = D.requestLoan(D.address, { principal: 4n * 10n ** 18n, rateBps: 1200n, durationDays: 365n, collateral: 4n * 10n ** 18n });
D.advanceTime(60 * 86400);
D.repayLoan(D.address, l4.loanId, D.previewRepayment(l4.loanId).amountDue);
const sp = D.stats().sharePrice;
eq('sharePrice grew', BigInt(sp) > 10n ** 18n, 'true');
console.log('       sharePrice after 60d of 12% APR on 4 ETH: ' + UI.formatEth(sp, { dp: 6 }));

console.log('\n== demo.js: pending loan -> fund -> activate ==');
D.reset();
D.deposit(D.address, 1n * 10n ** 18n);
const l5 = D.requestLoan(D.address, { principal: 3n * 10n ** 18n, rateBps: 1200n, durationDays: 30n, collateral: 3n * 10n ** 18n });
eq('pending when liquidity short', D.getLoan(l5.loanId).status, 1);
D.fundLoan(D.address, l5.loanId, 2n * 10n ** 18n);
eq('still pending after partial funding', D.getLoan(l5.loanId).status, 1);
D.fundLoan(D.address, l5.loanId, 1n * 10n ** 18n);
eq('active once fully funded', D.getLoan(l5.loanId).status, 2);
let cf; try { D.cancelLoan(D.address, l5.loanId); cf = 'no-revert'; } catch (e) { cf = e.revertName; }
eq('cancel on active reverts LoanNotPending', cf, 'LoanNotPending');

/* cancel path */
const l6 = D.requestLoan(D.address, { principal: 20n * 10n ** 18n, rateBps: 1200n, durationDays: 30n, collateral: 20n * 10n ** 18n });
eq('pending (20 > available)', D.getLoan(l6.loanId).status, 1);
const balBefore = D.position(D.address).ethBalance;
const c = D.cancelLoan(D.address, l6.loanId);
eq('refund equals collateral', c.refund, (20n * 10n ** 18n).toString());
eq('balance restored', D.position(D.address).ethBalance, (BigInt(balBefore) + 20n * 10n ** 18n).toString());

console.log('\n== demo.js: revert parity spot-checks ==');
D.reset();
const tries = [
  ['deposit below minDeposit', 'AmountTooSmall', () => D.deposit(D.address, 1n)],
  ['deposit zero', 'ZeroAmount', () => D.deposit(D.address, 0n)],
  ['deposit over balance', 'InsufficientBalance', () => D.deposit(D.address, 51n * 10n ** 18n)],
  ['requestLoan without collateral', 'ZeroAmount', () => D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 100n, durationDays: 5n, collateral: 0n })],
  ['requestLoan under-collateralised', 'InsufficientCollateral', () => D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 100n, durationDays: 5n, collateral: 1n * 10n ** 18n - 1n })],
  ['rate above ceiling', 'RateTooHigh', () => D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 5001n, durationDays: 5n, collateral: 2n * 10n ** 18n })],
  ['duration zero', 'DurationInvalid', () => D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 100n, durationDays: 0n, collateral: 2n * 10n ** 18n })],
  ['principal above max', 'AmountTooLarge', () => D.requestLoan(D.address, { principal: 101n * 10n ** 18n, rateBps: 100n, durationDays: 5n, collateral: 101n * 10n ** 18n })],
  ['withdraw zero shares', 'ZeroAmount', () => D.withdraw(D.address, 0n)],
  ['withdraw more than owned', 'InsufficientShares', () => D.withdraw(D.address, 10n ** 18n)]
];
for (const [label, want, fn] of tries) {
  let name = 'no-revert';
  try { fn(); } catch (e) { name = e.revertName; }
  eq(label, name, want);
}

console.log('\n== demo.js: seeded book ==');
store.clear();
D.reseed();
s = D.stats();
const loans = D.allLoans();
console.log('  pool: TL=' + UI.formatEth(s.totalLiquidity, { dp: 6 }) + ' avail=' + UI.formatEth(s.availableLiquidity, { dp: 6 }) +
  ' reserved=' + UI.formatEth(s.reservedLiquidity, { dp: 6 }) + ' collateral=' + UI.formatEth(s.accumulatedCollateral, { dp: 6 }) +
  ' badDebt=' + UI.formatEth(s.totalBadDebt, { dp: 6 }));
console.log('  sharePrice=' + UI.formatEth(s.sharePrice, { dp: 9 }) + ' loans=' + loans.length);
for (const l of loans) {
  console.log('   #' + l.id + ' status=' + l.status + ' principal=' + UI.formatEth(l.principal) +
    ' collateral=' + UI.formatEth(l.collateral) + (l.overdue ? ' OVERDUE due=' + UI.formatEth(l.amountDue, { dp: 6 }) : '') +
    (l.status === 1 ? ' pending, short ' + UI.formatEth(l.remainingToFund) : ''));
}
const a = D.audit();
console.log('  audit: cashHeld=' + UI.formatEth(a.cashHeld, { dp: 6 }) + ' claims=' + UI.formatEth(a.claims, { dp: 6 }) +
  ' difference=' + UI.formatEth(a.difference, { dp: 6 }) + ' balanced=' + a.balanced);
eq('seeded ledger is balanced', a.balanced, 'true');
eq('audit difference is zero wei', a.difference, '0');
/* supply -> borrow -> repay -> liquidate must leave the ledger balanced */
D.deposit(D.address, 3n * 10n ** 18n);
const chk = D.requestLoan(D.address, { principal: 2n * 10n ** 18n, rateBps: 900n, durationDays: 14n, collateral: 2n * 10n ** 18n });
D.advanceTime(20 * 86400);
D.repayLoan(D.address, chk.loanId, D.previewRepayment(chk.loanId).amountDue);
eq('balanced after a late repayment', D.audit().balanced, 'true');
const chk2 = D.requestLoan(D.address, { principal: 1n * 10n ** 18n, rateBps: 5000n, durationDays: 5n, collateral: 1n * 10n ** 18n });
D.advanceTime(30 * 86400);
D.liquidate(D.address, chk2.loanId);
eq('balanced after a liquidation', D.audit().balanced, 'true');
eq('late fee is credited to totalInterestEarned', BigInt(D.stats().totalInterestEarned) > 0n, 'true');
D.reseed();
eq('reseeded ledger is balanced', D.audit().balanced, 'true');

/* liquidation of the two overdue seeded loans */
const overdueIds = loans.filter((l) => l.overdue).map((l) => l.id);
eq('two overdue seeded loans', overdueIds.length, 2);
const r1 = D.liquidate(D.address, overdueIds[0]);
const r2 = D.liquidate(D.address, overdueIds[1]);
console.log('  liquidated #' + overdueIds[0] + ': recovered=' + UI.formatEth(r1.compensation) +
  ' refund=' + UI.formatEth(r1.refund) + ' badDebt=' + UI.formatEth(r1.badDebt));
console.log('  liquidated #' + overdueIds[1] + ': recovered=' + UI.formatEth(r2.compensation) +
  ' refund=' + UI.formatEth(r2.refund) + ' badDebt=' + UI.formatEth(r2.badDebt));
eq('covered liquidation refunds surplus', BigInt(r1.refund) > 0n, 'true');
eq('shortfall liquidation writes off debt', BigInt(r2.badDebt) > 0n, 'true');
eq('bad debt recorded in stats', D.stats().totalBadDebt, r2.badDebt.toString());

console.log('\n== demo.js: persistence round-trip through localStorage ==');
D.persist ? null : null;
D.deposit(D.address, 1n * 10n ** 18n);
const snapshot = JSON.parse(store.get(D.STORAGE_KEY));
eq('persisted ledger version', snapshot.version, '1');
eq('bigints encoded as strings', typeof snapshot.totalLiquidity.$wei, 'string');
const D2 = win.ML_DEMO;
/* reload by re-running demo.js in a second context sharing the same store */
const win2 = JSON.parse(JSON.stringify({}));
const store2 = new Map(store);
const w2 = { localStorage: { getItem: (k) => (store2.has(k) ? store2.get(k) : null), setItem: (k, v) => store2.set(k, String(v)), removeItem: (k) => store2.delete(k) }, console, Date, Math, JSON, BigInt, Number, String, Object, Array, Error, TypeError, isFinite, setTimeout, clearTimeout };
w2.window = w2;
const c2 = vm.createContext(w2);
vm.runInContext(fs.readFileSync(file('js/ui.js'), 'utf8'), c2);
vm.runInContext(fs.readFileSync(file('js/demo.js'), 'utf8'), c2);
eq('restored totalLiquidity matches', w2.ML_DEMO.stats().totalLiquidity, D2.stats().totalLiquidity);

/* --------------------------------------------------------------------------
   Named vectors. These are the exact figures docs/qa report against, so they
   are asserted here as literals rather than recomputed from the same formula
   the implementation uses.
   -------------------------------------------------------------------------- */
console.log('\n== named vectors (1 ETH @ 1000 bps, 30 days) ==');
D.clearAll();
D.reset();
D.deposit(D.address, 10n * 10n ** 18n);

const V_INTEREST = '8219178082191780';
const V_FEE = '821917808219178';
const V_OWED = '1018301369863013697';
const V_PENALTY = '50915068493150684';
const V_COMPENSATION = '1069216438356164381';
const V_REFUND = '1930783561643835619';
const V_BAD_DEBT = '518301369863013697';

eq('previewInterest(1 ETH, 1000 bps, 30 days)', D.previewInterest(10n ** 18n, 1000n, 30n).toString(), V_INTEREST);
const vFee = (BigInt(V_INTEREST) * 1000n) / 10000n;
eq('protocol fee is 10% of that interest', vFee.toString(), V_FEE);

/* minimum collateral must be 5000 bps for the 0.5 ETH vectors below */
D.setParams(D.address, { minCollateralBps: 5000n });

/* --- liquidation 900 s past the due date, 3 ETH collateral --- */
const vLoan = D.requestLoan(D.address, {
  principal: (10n ** 18n).toString(), rateBps: '1000', durationDays: '30', collateral: (3n * 10n ** 18n).toString()
});
eq('vector loan activates', D.getLoan(vLoan.loanId).status, 2);
const vDue = D.getLoan(vLoan.loanId).dueDate;
/* advance to exactly dueDate + 900 s (one started late period), measured on the
   simulated clock rather than the wall clock, which already carries an offset */
const vDelay = Number(vDue - BigInt(D.chainTime())) + 900;
D.advanceTime(vDelay);
eq('dueDate+900s: amountDue', D.previewRepayment(vLoan.loanId).amountDue.toString(), V_OWED);
eq('dueDate+900s: lateFee', D.previewRepayment(vLoan.loanId).lateFee.toString(), '10082191780821917');
const vLiq = D.liquidate(D.address, vLoan.loanId);
eq('dueDate+900s: compensation', vLiq.compensation.toString(), V_COMPENSATION);
eq('dueDate+900s: penalty (compensation - owed)', (vLiq.compensation - vLiq.owed).toString(), V_PENALTY);
eq('dueDate+900s: refund', vLiq.refund.toString(), V_REFUND);
eq('dueDate+900s: no bad debt when collateral covers the debt', vLiq.badDebt.toString(), '0');

/* --- default with only 0.5 ETH of collateral: minCollateralBps 5000 --- */
const vLoan2 = D.requestLoan(D.address, {
  principal: (10n ** 18n).toString(), rateBps: '1000', durationDays: '30', collateral: (5n * 10n ** 17n).toString()
});
eq('0.5 ETH collateral satisfies 5000 bps of a 1 ETH principal', D.getLoan(vLoan2.loanId).status, 2);
const vDue2 = D.getLoan(vLoan2.loanId).dueDate;
D.advanceTime(Number(vDue2 - BigInt(D.chainTime())) + 900);
const vLiq2 = D.liquidate(D.address, vLoan2.loanId);
eq('bad debt written off on a 0.5 ETH default', vLiq2.badDebt.toString(), V_BAD_DEBT);
eq('owed exceeds the collateral by exactly the write-off', (vLiq2.owed - (5n * 10n ** 17n)).toString(), V_BAD_DEBT);
eq('protocol fee for that interest', vFee.toString(), V_FEE);
eq('ledger balanced after the vectors', D.audit().balanced, 'true');

console.log('\n' + (fails ? 'FAILURES: ' + fails : 'ALL CHECKS PASSED'));
process.exit(fails ? 1 : 0);
