"use strict";
/**
 * Suite 08 — cancelLoan(): borrower-only, Pending-only, unfunded-only, collateral refund.
 * Spec rule 9.
 */
const { H, D, SUPPLY, bootstrap, requestLoan } = require("./_helpers");

async function run(ctx, t) {
  const a1 = ctx.addressOf(1);
  const a2 = ctx.addressOf(2);

  // ---------------- happy path ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const principal = 20n * D; // above free liquidity -> Pending
    await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    t.wei(await pool.pendingLoanCountOf(a1), 1n, "the request is pending before cancellation");
    t.wei(await pool.accumulatedCollateral(), principal, "the pending collateral is pooled");

    const poolBefore = await ctx.balance(pool.target);
    const borrowerBefore = await ctx.balance(a1);
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).cancelLoan(1n));
    const gas = receipt.gasUsed * receipt.gasPrice;

    t.event(receipt, pool, "LoanCancelled", [1n, a1, principal], "LoanCancelled(loanId, borrower, collateralRefunded)");
    t.wei((await ctx.balance(a1)) - borrowerBefore, principal - gas, "the borrower gets the full collateral back (net of gas)");
    t.wei(poolBefore - (await ctx.balance(pool.target)), principal, "the pool releases exactly the collateral");
    t.wei((await pool.getLoan(1n)).status, 5n, "the loan is marked Cancelled");
    t.wei((await pool.getLoan(1n)).collateral, 0n, "the cancelled loan holds no collateral");
    t.wei(await pool.accumulatedCollateral(), 0n, "accumulatedCollateral is cleared");
    t.wei(await pool.pendingLoanCountOf(a1), 0n, "pendingLoanCountOf[borrower] drops to zero");
    t.wei(await pool.totalLiquidity(), SUPPLY, "cancelling a loan does not touch totalLiquidity");
    t.wei(await ctx.balance(pool.target), SUPPLY, "the pool balance returns to the supplier deposit");
    await t.reverts(() => pool.connect(ctx.signer(1)).cancelLoan.staticCall(1n), "LoanNotPending", [1n], "cancelling twice reverts LoanNotPending(id)");
  }

  // ---------------- access control ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const principal = 20n * D;
    await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    await t.reverts(
      () => pool.connect(ctx.signer(2)).cancelLoan.staticCall(1n),
      "NotBorrower",
      [a2],
      "a non-borrower cancelling reverts NotBorrower(caller)"
    );
    await t.reverts(
      () => pool.cancelLoan.staticCall(1n),
      "NotBorrower",
      [ctx.addressOf(0)],
      "even the owner cannot cancel somebody else's request (NotBorrower)"
    );
    await t.reverts(() => pool.cancelLoan.staticCall(99n), "InvalidLoan", [99n], "cancelLoan on an unknown id reverts InvalidLoan(id)");
  }

  // ---------------- status gate: only Pending ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D }); // Active
    await t.reverts(
      () => pool.connect(ctx.signer(1)).cancelLoan.staticCall(1n),
      "LoanNotPending",
      [1n],
      "cancelling an Active loan reverts LoanNotPending(id)"
    );

    const { loan } = await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(2n, { value: await pool.previewRepayment(2n).then((r) => r[0]) }));
    await t.reverts(
      () => pool.connect(ctx.signer(1)).cancelLoan.staticCall(2n),
      "LoanNotPending",
      [2n],
      "cancelling a Repaid loan reverts LoanNotPending(id)"
    );
    t.wei((await pool.getLoan(2n)).status, 3n, "the repaid loan is untouched by the failed cancel");
    t.check(loan.status === 2n, "the second loan had been active before repayment");
  }

  // ---------------- funding gate: NotFunded once partially funded ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false, supply: 0n });
    const principal = D;
    await requestLoan(ctx, pool, 1, { principal, collateral: principal }); // no liquidity -> Pending
    const partial = principal / 2n;
    await ctx.send(pool.connect(ctx.signer(2)).fundLoan(1n, { value: partial }));
    t.wei((await pool.getLoan(1n)).amountFunded, partial, "the loan is partially funded");
    t.wei((await pool.getLoan(1n)).status, 1n, "a partially funded loan is still Pending");

    await t.reverts(
      () => pool.connect(ctx.signer(1)).cancelLoan.staticCall(1n),
      "NotFunded",
      [partial, principal],
      "cancelling a funded request reverts NotFunded(funded, principal)"
    );
    // once fully funded (and activated) cancel is impossible for another reason
    await ctx.send(pool.connect(ctx.signer(2)).fundLoan(1n, { value: principal - partial }));
    t.wei((await pool.getLoan(1n)).status, 2n, "full funding activated the loan");
    await t.reverts(() => pool.connect(ctx.signer(1)).cancelLoan.staticCall(1n), "LoanNotPending", [1n], "an active loan cannot be cancelled");
  }

  // ---------------- cancellation is allowed while paused (exit path) ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const principal = 20n * D;
    await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).cancelLoan(1n));
    t.wei((await pool.getLoan(1n)).status, 5n, "cancelLoan works while the pool is paused");
    t.event(receipt, pool, "LoanCancelled", [1n, a1, principal], "the paused cancellation emits the exact refund");
    t.eq(await pool.paused(), true, "the pool stays paused after the cancellation");
  }
}

module.exports = { name: "08 cancelLoan (borrower-only, pending-only, refund)", run };
