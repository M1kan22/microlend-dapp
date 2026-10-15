"use strict";
/**
 * Suite 11 — Read helpers (spec 2.4) and the view-level invariants.
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, simpleInterest } = require("./_helpers");

const PRINCIPAL = D;
const INTEREST = simpleInterest(PRINCIPAL, 1000n, 30n);
const OWED = PRINCIPAL + INTEREST;

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);

  // ---------------- pure preview helpers ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false });
    t.wei(await pool.previewInterest(PRINCIPAL, 1000n, 30n), 8_219_178_082_191_780n, "previewInterest matches the spec formula exactly");
    t.wei(await pool.previewInterest(PRINCIPAL, 0n, 365n), 0n, "0 bps charges no interest");
    t.wei(await pool.previewInterest(PRINCIPAL, 10_000n, 365n), PRINCIPAL, "100% APR for 365 days is exactly the principal");
    t.wei(await pool.previewInterest(10n ** 13n, 5_000n, 365n), 5n * 10n ** 12n, "a 0.00001 ETH loan at 50% APR for a year is exact");
    t.wei(await pool.previewInterest(3n, 10_000n, 1n), 0n, "sub-wei interest truncates to 0 (integer maths)");
    const quote = await pool.quoteCollateral(PRINCIPAL, 1000n, 30n);
    t.wei(quote[0], PRINCIPAL, "quoteCollateral at 10000 bps requires exactly the principal");
    t.wei(quote[1], OWED, "quoteCollateral totalDue == principal + interest");
    t.wei(quote[1] - quote[0], INTEREST, "the difference between totalDue and collateral is the interest");
  }

  // ---------------- conversion helpers on an empty pool ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false });
    t.wei(await pool.sharePrice(), D, "an empty pool reports a nominal 1e18 share price");
    t.wei(await pool.convertToShares(D), D, "empty pool: convertToShares(assets) == assets (bootstrap 1:1)");
    t.wei(await pool.convertToAssets(D), 0n, "empty pool: convertToAssets(shares) == 0 (no supply)");
  }

  // ---------------- live pool with one active loan ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const { loan } = await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: PRINCIPAL });

    t.wei(await pool.sharePrice(), D, "share price is 1e18 while no interest has been earned");
    t.wei(await pool.convertToShares(D), D, "convertToShares is 1:1 at the bootstrap price");
    t.wei(await pool.convertToAssets(D), D, "convertToAssets round-trips at the bootstrap price");
    t.wei(await pool.convertToAssets(await pool.convertToShares(5n * D)), 5n * D, "convertToAssets(convertToShares(x)) == x at 1:1");

    const loanView = await pool.getLoan(1n);
    t.wei(loanView.id, 1n, "getLoan.id");
    t.eq(loanView.borrower, a1, "getLoan.borrower");
    t.wei(loanView.principal, PRINCIPAL, "getLoan.principal");
    t.wei(loanView.collateral, PRINCIPAL, "getLoan.collateral");
    t.wei(loanView.interest, INTEREST, "getLoan.interest");
    t.wei(loanView.rateBps, 1000n, "getLoan.rateBps");
    t.wei(loanView.durationDays, 30n, "getLoan.durationDays");
    t.wei(loanView.dueDate - loanView.startTime, 30n * 86400n, "getLoan.startTime/dueDate span the term");
    t.wei(loanView.amountFunded, PRINCIPAL, "getLoan.amountFunded");
    t.wei(loanView.status, 2n, "getLoan.status == Active (2)");

    const stats = await pool.poolStats();
    t.wei(stats[0], SUPPLY, "poolStats.totalShares");
    t.wei(stats[1], SUPPLY, "poolStats.totalLiquidity");
    t.wei(stats[2], SUPPLY - PRINCIPAL, "poolStats.availableLiquidity");
    t.wei(stats[3], PRINCIPAL, "poolStats.reservedLiquidity");
    t.wei(stats[4], SUPPLY, "poolStats.totalDeposited");
    t.wei(stats[5], 0n, "poolStats.totalInterestEarned");
    t.wei(stats[6], 0n, "poolStats.totalFeesCollected");
    t.wei(stats[7], 0n, "poolStats.totalBadDebt");
    t.wei(stats[8], 0n, "poolStats.treasuryBalance");
    t.wei(stats[9], 1n, "poolStats.loanCount");
    t.wei(stats[10], D, "poolStats.sharePrice");
    t.eq(stats[11], false, "poolStats.paused");

    const liab = await pool.liabilities();
    t.wei(liab[0], SUPPLY, "liabilities.supplierClaims == totalLiquidity");
    t.wei(liab[1], PRINCIPAL, "liabilities.collateralHeld == accumulatedCollateral");
    t.wei(liab[2], 0n, "liabilities.fees == treasuryBalance");

    t.wei(await pool.collateralRatio(1n), (PRINCIPAL * BPS) / OWED, "collateralRatio == collateral * 10000 / totalDue (exact)");
    t.lt(await pool.collateralRatio(1n), BPS, "a 100% collateral loan is slightly under-collateralised once interest is added");
    t.wei(await pool.previewRepayment(1n).then((r) => r[0]), OWED, "previewRepayment.amountDue == principal + interest");
    t.wei(await pool.previewRepayment(1n).then((r) => r[1]), 0n, "previewRepayment.lateFee == 0 before the due date");

    t.eq(await pool.isOverdue(1n), false, "isOverdue is false during the term");
    t.includes(await pool.getUserLoans(a1), 1n, "getUserLoans(borrower) contains the loan id");
    t.wei((await pool.getUserLoans(a1)).length, 1n, "getUserLoans(borrower) has exactly one entry");
    t.wei((await pool.getUserLoans(ctx.addressOf(9))).length, 0n, "getUserLoans(unknown) is empty");

    const supplier = await pool.getUserPosition(a0);
    t.wei(supplier[0], SUPPLY - 1n, "getUserPosition.shares");
    t.wei(supplier[1], SUPPLY - 1n, "getUserPosition.shareValue");
    t.wei(supplier[2], 0n, "getUserPosition.collateralLocked is 0 for a pure supplier");
    t.wei(supplier[3], 0n, "getUserPosition.activeLoans is 0 for a pure supplier");
    t.wei(supplier[4], 0n, "getUserPosition.pendingLoans is 0 for a pure supplier");
    t.wei(supplier[5], 0n, "getUserPosition.outstandingDebt is 0 for a pure supplier");

    const borrower = await pool.getUserPosition(a1);
    t.wei(borrower[0], 0n, "borrower has no shares");
    t.wei(borrower[1], 0n, "borrower share value is 0");
    t.wei(borrower[2], PRINCIPAL, "getUserPosition.collateralLocked tracks the active loan");
    t.wei(borrower[3], 1n, "getUserPosition.activeLoans == 1");
    t.wei(borrower[4], 0n, "getUserPosition.pendingLoans == 0");
    t.wei(borrower[5], OWED, "getUserPosition.outstandingDebt == principal + interest");

    // excess collateral lifts the ratio
    const { loan: rich } = await requestLoan(ctx, pool, 2, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: 3n * D });
    t.wei(await pool.collateralRatio(2n), (3n * D * BPS) / OWED, "collateralRatio scales with the posted collateral");
    t.gt(await pool.collateralRatio(2n), BPS, "a 300% collateral loan is above 100% covered");
    t.gt(await pool.collateralRatio(2n), await pool.collateralRatio(1n), "more collateral means a higher ratio");
    t.wei(rich.collateral, 3n * D, "the excess-collateral loan stores the full collateral");

    const pending = await requestLoan(ctx, pool, 3, { principal: 50n * D, collateral: 50n * D });
    t.wei(pending.loan.status, 1n, "the over-sized request is pending");
    const pendingPosition = await pool.getUserPosition(ctx.addressOf(3));
    t.wei(pendingPosition[2], 50n * D, "pending collateral is reported in collateralLocked");
    t.wei(pendingPosition[3], 0n, "a pending loan does not count as active");
    t.wei(pendingPosition[4], 1n, "a pending loan is counted in pendingLoans");
    t.wei(pendingPosition[5], 0n, "a pending loan has no outstanding debt yet");
  }

  // ---------------- view errors ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.collateralRatio.staticCall(42n), "InvalidLoan", [42n], "collateralRatio on an unknown id reverts InvalidLoan(id)");
    await t.reverts(() => pool.previewRepayment.staticCall(42n), "InvalidLoan", [42n], "previewRepayment on an unknown id reverts InvalidLoan(id)");
    t.eq(await pool.isOverdue(42n), false, "isOverdue on an unknown id is false (no revert)");
    const unknown = await pool.getLoan(42n);
    t.wei(unknown.id, 0n, "getLoan on an unknown id returns the empty struct");
  }

  // ---------------- views after repayment ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: PRINCIPAL });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    const fee = (INTEREST * 1000n) / BPS;
    const netInterest = INTEREST - fee;

    t.wei(await pool.totalLiquidity(), SUPPLY + netInterest, "totalLiquidity after repayment == deposit + net interest");
    t.wei(await pool.sharePrice(), ((SUPPLY + netInterest) * D) / SUPPLY, "sharePrice reflects the earned net interest");
    t.gt(await pool.sharePrice(), D, "share price appreciates above 1:1");
    const liab = await pool.liabilities();
    t.wei(liab[0], SUPPLY + netInterest, "liabilities.supplierClaims == totalLiquidity");
    t.wei(liab[1], 0n, "no collateral is held after repayment");
    t.wei(liab[2], fee, "liabilities.fees == the accrued protocol fee");
    t.wei(await pool.totalInterestEarned(), INTEREST, "totalInterestEarned is the gross interest");
    t.wei(await pool.totalFeesCollected(), fee, "totalFeesCollected is the protocol cut");
    t.eq(await pool.isOverdue(1n), false, "a repaid loan is never overdue");
    t.wei((await pool.getUserPosition(a1))[2], 0n, "the repaid borrower has no collateral locked");
    t.wei((await pool.getUserPosition(a1))[5], 0n, "the repaid borrower has no outstanding debt");
  }
}

module.exports = { name: "11 read helpers (poolStats, positions, previews)", run };
