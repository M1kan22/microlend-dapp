"use strict";
/**
 * Suite 07 — liquidate(): overdue gate, excess-collateral refund, bad-debt shortfall.
 * Spec rule 8, plus the regression tests for the settlement accounting fix:
 * the sole supplier must be able to exit fully after both liquidation branches.
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, advancePastDue, dueOf, simpleInterest } = require("./_helpers");

const PRINCIPAL = D;
const INTEREST = simpleInterest(PRINCIPAL, 1000n, 30n);
const BASE = PRINCIPAL + INTEREST;

/** Independent implementation of the spec's liquidation maths. */
function expectedLiquidation({ now, loan, penaltyBps, lateFeeBps }) {
  const periods = (now - BigInt(loan.dueDate)) / (30n * 86400n) + 1n;
  const lateFee = (BASE * lateFeeBps * periods) / BPS;
  const owed = BASE + lateFee;
  let compensation;
  let refund;
  let writeOff = 0n;
  if (BigInt(loan.collateral) >= owed) {
    const penalty = (owed * penaltyBps) / BPS;
    compensation = owed + penalty;
    if (compensation > BigInt(loan.collateral)) compensation = BigInt(loan.collateral);
    refund = BigInt(loan.collateral) - compensation;
  } else {
    compensation = BigInt(loan.collateral);
    writeOff = owed - BigInt(loan.collateral);
  }
  return { periods, lateFee, owed, compensation, refund, writeOff };
}

async function run(ctx, t) {
  const a1 = ctx.addressOf(1);
  const a4 = ctx.addressOf(4);

  // =========================================================================
  // A + B: overdue gate and the excess-collateral branch (default 100% collateral)
  // =========================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: 3n * D });
    const loan = await pool.getLoan(1n);

    await t.reverts(
      () => pool.liquidate.staticCall(1n),
      "LoanNotOverdue",
      [1n],
      "liquidate before dueDate reverts LoanNotOverdue(id)"
    );

    // exactly at the due date is still NOT overdue (block.timestamp <= dueDate)
    const atDue = await ctx.advanceTo(loan.dueDate, { exact: true });
    t.wei(atDue, loan.dueDate, "the chain clock lands exactly on the due date");
    await t.reverts(
      () => pool.liquidate.staticCall(1n),
      "LoanNotOverdue",
      [1n],
      "liquidate exactly at dueDate reverts LoanNotOverdue(id) (strictly greater-than check)"
    );
    t.eq(await pool.isOverdue(1n), false, "isOverdue() is false exactly at the due date");

    // one second later it is overdue
    const now = await ctx.advanceTo(BigInt(loan.dueDate) + 900n);
    t.eq(await pool.isOverdue(1n), true, "isOverdue() is true past the due date");
    const penaltyBps = await pool.penaltyBps();
    const lateFeeBps = await pool.lateFeeBps();
    const expect = expectedLiquidation({ now, loan, penaltyBps, lateFeeBps });
    t.wei(expect.periods, 1n, "the liquidation lands in the first started late period");

    const preview = await dueOf(pool, 1n);
    t.wei(preview.amountDue, expect.owed, "previewRepayment at liquidation time == baseDue + lateFee (exact)");
    t.wei(preview.lateFee, expect.lateFee, "previewRepayment reports the exact late fee");
    t.wei(expect.compensation, expect.owed + (expect.owed * penaltyBps) / BPS, "excess-collateral compensation == owed + penalty");
    t.lt(expect.compensation, 3n * D, "the 3 ETH collateral covers the owed amount plus the penalty");

    const liquidatorBefore = await ctx.balance(a4);
    const borrowerBefore = await ctx.balance(a1);
    const receipt = await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    const gas = receipt.gasUsed * receipt.gasPrice;

    t.event(
      receipt,
      pool,
      "LoanLiquidated",
      [1n, a1, a4, 3n * D, expect.compensation, expect.refund, 0n],
      "LoanLiquidated(loanId, borrower, liquidator, collateralSeized, compensation, refund, badDebt)"
    );
    t.wei((await ctx.balance(a1)) - borrowerBefore, expect.refund, "the excess collateral is refunded to the borrower");
    t.wei((await ctx.balance(a4)) - liquidatorBefore, -gas, "the liquidator is paid no bounty (only gas)");
    t.wei(expect.refund, 3n * D - expect.compensation, "refund == collateral - compensation (exact)");

    const loanAfter = await pool.getLoan(1n);
    t.wei(loanAfter.status, 4n, "the loan is marked Liquidated");
    t.wei(loanAfter.collateral, 0n, "the seized collateral is zeroed on the loan");
    t.wei(await pool.accumulatedCollateral(), 0n, "accumulatedCollateral releases the seizure");
    t.wei(await pool.reservedLiquidity(), 0n, "the principal reservation is released");
    t.wei(await pool.activeLoanCountOf(a1), 0n, "activeLoanCountOf[borrower] drops to zero");
    t.wei(await pool.totalBadDebt(), 0n, "no bad debt is recorded in the excess-collateral branch");
    t.wei(
      await pool.totalLiquidity(),
      SUPPLY - PRINCIPAL + expect.compensation,
      "totalLiquidity == deposit - principal + compensation (suppliers give up the principal claim, take the seizure)"
    );
    t.wei(await pool.totalInterestEarned(), expect.owed - PRINCIPAL, "totalInterestEarned records owed - principal (interest + late fee)");
    t.wei(await pool.treasuryBalance(), 0n, "liquidation collects no protocol fee");

    await t.reverts(() => pool.liquidate.staticCall(1n), "LoanNotActive", [1n], "liquidating the same loan twice reverts LoanNotActive(id)");

    // ---- regression: the SOLE supplier can still exit fully ----
    const tlAfter = await pool.totalLiquidity();
    const totalShares = await pool.totalShares();
    const shares = await pool.sharesOf(ctx.addressOf(0));
    const expectedAssets = (shares * tlAfter) / totalShares;
    t.wei(await pool.convertToAssets(shares), expectedAssets, "the sole supplier's claim is exactly floor(shares * totalLiquidity / totalShares)");
    t.wei(expectedAssets, tlAfter - 2n, "with the 1 wei dead share the redemption is totalLiquidity - 2 wei");
    t.gt(await pool.convertToAssets(shares), SUPPLY - PRINCIPAL, "after an excess-collateral liquidation the supplier is still whole");

    const supplierBefore = await ctx.balance(ctx.addressOf(0));
    const exit = await ctx.send(pool.withdraw(shares));
    const exitGas = exit.gasUsed * exit.gasPrice;
    t.event(exit, pool, "LiquidityWithdrawn", [ctx.addressOf(0), shares, expectedAssets], "the sole supplier's full exit succeeds after liquidation");
    t.wei((await ctx.balance(ctx.addressOf(0))) - supplierBefore, expectedAssets - exitGas, "the supplier receives the exact redemption (net of gas)");
    t.wei(await pool.totalShares(), 1n, "only the dead share remains");
    t.wei(await pool.totalLiquidity(), tlAfter - expectedAssets, "the remainder is exactly the rounding dust");
    t.wei(tlAfter - expectedAssets, 2n, "rounding dust is exactly 2 wei");
    t.wei(await ctx.balance(pool.target), (await pool.totalLiquidity()) + (await pool.treasuryBalance()), "the pool drains to exactly liabilities after the exit");
    t.lte(
      (await pool.totalLiquidity()) - (await pool.reservedLiquidity()),
      await ctx.balance(pool.target),
      "the remaining free-liquidity claim is fully backed by ETH in the contract"
    );
  }

  // =========================================================================
  // C: bad-debt shortfall branch (minCollateralBps lowered to 5_000)
  // =========================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setParams(10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 5_000n, 1_000n, 500n, 100n));
    t.wei(await pool.minCollateralBps(), 5_000n, "owner lowered minCollateralBps to the 5_000 floor");

    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: D / 2n });
    const loan = await pool.getLoan(1n);
    t.wei(loan.collateral, D / 2n, "the loan only posts 50% collateral (allowed at 5_000 bps)");
    const now = await advancePastDue(ctx, pool, 1n, 900n);
    const penaltyBps = await pool.penaltyBps();
    const lateFeeBps = await pool.lateFeeBps();
    const expect = expectedLiquidation({ now, loan, penaltyBps, lateFeeBps });
    t.wei(expect.compensation, D / 2n, "on a shortfall the compensation is capped at the collateral");
    t.wei(expect.writeOff, expect.owed - D / 2n, "the uncovered remainder is owed - collateral");
    t.gt(expect.writeOff, 0n, "the shortfall is positive and reachable with 50% collateral");

    const borrowerBefore = await ctx.balance(a1);
    const receipt = await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    t.event(
      receipt,
      pool,
      "LoanLiquidated",
      [1n, a1, a4, D / 2n, D / 2n, 0n, expect.writeOff],
      "LoanLiquidated reports compensation == collateral, refund == 0 and the exact bad debt"
    );
    t.wei((await ctx.balance(a1)) - borrowerBefore, 0n, "the defaulting borrower receives no refund (the liquidator pays the gas)");
    t.wei(await pool.totalBadDebt(), expect.writeOff, "totalBadDebt == owed - collateral (exact)");
    t.wei(await pool.accumulatedCollateral(), 0n, "the seized collateral leaves accumulatedCollateral");
    const stats = await pool.poolStats();
    t.lte(stats[3], stats[1], "reservedLiquidity <= totalLiquidity after a shortfall liquidation (no underflow)");
    t.wei(stats[3], 0n, "the reservation is fully released");
    t.wei(stats[2], stats[1], "availableLiquidity == totalLiquidity - reservedLiquidity");
    t.wei(
      await pool.totalLiquidity(),
      SUPPLY - PRINCIPAL + D / 2n,
      "totalLiquidity == deposit - principal + collateral (suppliers absorb the 0.5 ETH shortfall)"
    );
    t.lt(await pool.totalLiquidity(), SUPPLY, "suppliers are the residual claimant: their claim drops below the deposit");
    t.eq(await pool.isOverdue(1n), false, "a liquidated loan is no longer reported overdue");

    // ---- regression: the sole supplier exits and eats exactly the bad-debt loss ----
    const tlAfter = await pool.totalLiquidity();
    const totalShares = await pool.totalShares();
    const shares = await pool.sharesOf(ctx.addressOf(0));
    const expectedAssets = (shares * tlAfter) / totalShares;
    t.wei(await pool.convertToAssets(shares), expectedAssets, "the sole supplier's claim reflects the written-off principal");
    t.lt(expectedAssets, SUPPLY, "the sole supplier's redemption is now strictly less than the deposit");
    t.wei(SUPPLY - expectedAssets, PRINCIPAL - D / 2n + 1n, "the supplier's realised loss is exactly principal - collateral + 1 wei dust");

    const supplierBefore = await ctx.balance(ctx.addressOf(0));
    const exit = await ctx.send(pool.withdraw(shares));
    const exitGas = exit.gasUsed * exit.gasPrice;
    t.event(exit, pool, "LiquidityWithdrawn", [ctx.addressOf(0), shares, expectedAssets], "the sole supplier can still exit fully after a bad-debt liquidation");
    t.wei((await ctx.balance(ctx.addressOf(0))) - supplierBefore, expectedAssets - exitGas, "the supplier receives the reduced redemption (net of gas)");
    t.wei(await pool.totalShares(), 1n, "only the dead share remains after the exit");
    t.wei(await pool.totalLiquidity(), tlAfter - expectedAssets, "the dust remainder is exactly the rounding difference");
    t.wei(await ctx.balance(pool.target), (await pool.totalLiquidity()) + (await pool.treasuryBalance()), "the pool drains to exactly liabilities after the loss-making exit");
    t.wei(await pool.treasuryBalance(), 0n, "a defaulted loan collects no protocol fee");
  }

  // =========================================================================
  // D: NothingToWithdraw becomes reachable once totalLiquidity < totalShares
  // =========================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setParams(10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 5_000n, 1_000n, 500n, 100n));
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 30n, collateral: D / 2n });
    await advancePastDue(ctx, pool, 1n, 900n);
    await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    t.lt(await pool.totalLiquidity(), await pool.totalShares(), "after the loss, totalLiquidity < totalShares");

    await ctx.send(pool.setParams(1n, 10n ** 13n, 100n * D, 365n, 5_000n, 5_000n, 1_000n, 500n, 100n));
    await ctx.send(pool.connect(ctx.signer(6)).deposit({ value: 1n }));
    t.wei(await pool.sharesOf(ctx.addressOf(6)), 1n, "the 1 wei depositor receives exactly 1 share");
    t.wei(await pool.convertToAssets(1n), 0n, "that single share is worth 0 wei after the loss");
    await t.reverts(
      () => pool.connect(ctx.signer(6)).withdraw.staticCall(1n),
      "NothingToWithdraw",
      [],
      "withdrawing a share worth 0 wei reverts NothingToWithdraw"
    );
  }

  // =========================================================================
  // E: liquidate on non-active loans
  // =========================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.liquidate.staticCall(99n), "InvalidLoan", [99n], "liquidate on an unknown id reverts InvalidLoan(id)");

    await requestLoan(ctx, pool, 1, { principal: 20n * D, collateral: 20n * D }); // Pending
    await t.reverts(() => pool.liquidate.staticCall(1n), "LoanNotActive", [1n], "liquidating a Pending loan reverts LoanNotActive(id)");

    const { loan } = await requestLoan(ctx, pool, 2, { principal: PRINCIPAL, rateBps: 1000n, durationDays: 1n, collateral: 3n * D });
    await ctx.advanceTo(BigInt(loan.dueDate) + 60n);
    await ctx.send(pool.connect(ctx.signer(4)).liquidate(2n));
    t.wei((await pool.getLoan(2n)).status, 4n, "the second loan liquidates normally");
    await t.reverts(() => pool.liquidate.staticCall(1n), "LoanNotActive", [1n], "the Pending loan is still not liquidatable");
    t.wei((await pool.getLoan(1n)).status, 1n, "the pending loan keeps its status");
    t.wei(await pool.totalBadDebt(), 0n, "no bad debt from the covered loan");
    t.check((await ctx.balance(pool.target)) ===
      (await pool.totalLiquidity()) - (await pool.reservedLiquidity()) +
      (await pool.accumulatedCollateral()) + (await pool.treasuryBalance()),
      "money invariant after a mixed pending/liquidated book");
  }
}

module.exports = { name: "07 liquidate (both branches + supplier-exit regressions)", run };
