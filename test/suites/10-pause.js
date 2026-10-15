"use strict";
/**
 * Suite 10 — Pause behaviour matrix.
 * Spec rule 1/3/4/6: deposit / requestLoan / fundLoan are pause-gated; the exit and
 * risk-reducing paths (withdraw, repayLoan, cancelLoan, liquidate, claimTreasury) are not.
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, simpleInterest, advancePastDue } = require("./_helpers");

async function run(ctx, t) {
  const a1 = ctx.addressOf(1);
  const a2 = ctx.addressOf(2);

  // ---------------- the three blocked entry points ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setPaused(true));
    await t.reverts(() => pool.deposit.staticCall({ value: D }), "PoolPaused", [], "deposit() is blocked while paused");
    await t.reverts(
      () => pool.connect(ctx.signer(1)).requestLoan.staticCall(D, 1000n, 30n, { value: D }),
      "PoolPaused",
      [],
      "requestLoan() is blocked while paused"
    );

    // a pending loan created before the pause cannot be funded while paused
    const { pool: p2 } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, p2, 1, { principal: 20n * D, collateral: 20n * D });
    await ctx.send(p2.setPaused(true));
    await t.reverts(() => p2.fundLoan.staticCall(1n, { value: D }), "PoolPaused", [], "fundLoan() is blocked while paused");

    t.eq((await pool.poolStats())[11], true, "poolStats reports the paused flag");
    t.wei(await pool.loanCount(), 0n, "the blocked requestLoan created no loan");
  }

  // ---------------- withdrawal remains available ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setPaused(true));
    const shares = 3n * D;
    const receipt = await ctx.send(pool.withdraw(shares));
    t.event(receipt, pool, "LiquidityWithdrawn", [ctx.addressOf(0), shares, shares], "withdraw() succeeds while paused");
    t.wei(await pool.sharesOf(ctx.addressOf(0)), SUPPLY - 1n - shares, "the paused exit burns exactly the requested shares");
    t.eq(await pool.paused(), true, "the pool remains paused");
  }

  // ---------------- repayment remains available ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    const { amountDue } = await dueOf(pool, 1n);
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: amountDue }));
    t.wei((await pool.getLoan(1n)).status, 3n, "repayLoan() succeeds while paused");
    t.event(receipt, pool, "LoanRepaid", [1n, a1, D, simpleInterest(D, 1000n, 30n), 0n, (simpleInterest(D, 1000n, 30n) * 1000n) / BPS, amountDue],
      "the paused repayment reports the exact figures");
    t.eq(await pool.paused(), true, "the pool remains paused after repayment");
  }

  // ---------------- cancellation remains available ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const principal = 20n * D;
    await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).cancelLoan(1n));
    t.wei((await pool.getLoan(1n)).status, 5n, "cancelLoan() succeeds while paused");
    t.event(receipt, pool, "LoanCancelled", [1n, a1, principal], "the paused cancellation refunds the collateral");
  }

  // ---------------- liquidation remains available ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: 3n * D });
    await advancePastDue(ctx, pool, 1n, 900n);
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    t.wei((await pool.getLoan(1n)).status, 4n, "liquidate() succeeds while paused");
    t.event(receipt, pool, "LoanLiquidated", undefined, "the paused liquidation emits LoanLiquidated");
    t.wei(await pool.totalBadDebt(), 0n, "the paused liquidation recorded no bad debt");
  }

  // ---------------- treasury claims remain available ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const interest = simpleInterest(D, 1000n, 30n);
    const fee = (interest * 1000n) / BPS;
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.claimTreasury(a2));
    t.event(receipt, pool, "TreasuryClaimed", [a2, fee], "claimTreasury() succeeds while paused");
    t.wei(await pool.treasuryBalance(), 0n, "the paused claim drains treasuryBalance");
  }

  // ---------------- unpause restores the blocked paths ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setPaused(true));
    await t.reverts(() => pool.deposit.staticCall({ value: D }), "PoolPaused", [], "deposit is blocked while paused (pre-condition)");
    const receipt = await ctx.send(pool.setPaused(false));
    t.event(receipt, pool, "PausedSet", [false], "unpausing emits PausedSet(false)");
    const ok = await ctx.send(pool.connect(ctx.signer(2)).deposit({ value: D }));
    t.event(ok, pool, "LiquidityDeposited", [a2, D, D], "deposit works again after unpausing");
    t.wei(await pool.sharesOf(a2), D, "the post-unpause deposit minted the pro-rata shares");
    t.eq(await pool.paused(), false, "the pool reports unpaused");
  }

  // ---------------- only the owner may pause ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.connect(ctx.signer(3)).setPaused.staticCall(true), "NotOwner", [], "a non-owner cannot pause the pool");
    t.eq(await pool.paused(), false, "the failed call left the pool running");
  }
}

module.exports = { name: "10 pause behaviour matrix", run };
