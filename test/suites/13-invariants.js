"use strict";
/**
 * Suite 13 — Spec rule 12: the money invariant asserted after every scenario, plus the
 * corollaries amended into the spec, plus the exact deviation of the *literal* rule-12 text
 * that the contract intentionally does not satisfy (the dead share is a share, not extra wei).
 *
 *   address(pool).balance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, advancePastDue, simpleInterest } = require("./_helpers");

/** Assert the canonical identity plus the three corollaries. Returns the snapshot. */
async function check(t, ctx, pool, label, { badDebt = 0n } = {}) {
  const snapshot = await H.assertMoneyInvariant(t, pool, label, ctx);
  const stats = await pool.poolStats();
  const tl = BigInt(stats[1]);
  const available = BigInt(stats[2]);
  const reserved = BigInt(stats[3]);
  t.check(available === tl - reserved, `${label}: availableLiquidity == totalLiquidity - reservedLiquidity`, `${available} != ${tl} - ${reserved}`);
  t.lte(reserved, tl, `${label}: reservedLiquidity <= totalLiquidity`);
  t.wei(await pool.totalBadDebt(), badDebt, `${label}: totalBadDebt == expected write-off`);
  t.wei(
    snapshot.balance,
    snapshot.available + snapshot.collateral + snapshot.fees,
    `${label}: balance decomposes into free liquidity + collateral + fees`
  );
  return snapshot;
}

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);
  const feeOf = (interest) => (interest * 1000n) / BPS;

  // 1 — bootstrap deposit
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const r = await check(t, ctx, pool, "1 bootstrap deposit");
    t.wei(r.balance, SUPPLY, "1: the contract holds exactly the deposit");
    t.wei(r.reserved, 0n, "1: nothing is reserved yet");
  }

  // 2 — second deposit
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.connect(ctx.signer(1)).deposit({ value: 5n * D }));
    const r = await check(t, ctx, pool, "2 second deposit");
    t.wei(r.balance, SUPPLY + 5n * D, "2: the contract holds both deposits");
  }

  // 3 — instant loan activation (the principal moves out of the contract)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    const r = await check(t, ctx, pool, "3 loan activation");
    t.wei(r.balance, SUPPLY, "3: collateral in, principal out — the balance is back to the deposit");
    t.wei(r.reserved, D, "3: the principal is reserved");
    t.wei(r.totalLiquidity, SUPPLY, "3: totalLiquidity still includes the lent principal (suppliers hold the claim)");
  }

  // 4 — partial fundLoan
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 20n * D, collateral: 20n * D });
    await ctx.send(pool.connect(ctx.signer(2)).fundLoan(1n, { value: 5n * D }));
    const r = await check(t, ctx, pool, "4 partial fundLoan");
    t.wei(r.collateral, 20n * D, "4: the pending collateral is still held");
    t.wei(r.reserved, 0n, "4: a partially funded loan reserves nothing");
  }

  // 5 — fundLoan completion (activation pays the borrower out of the pooled funding)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 15n * D, collateral: 15n * D });
    await ctx.send(pool.connect(ctx.signer(2)).fundLoan(1n, { value: 15n * D }));
    const r = await check(t, ctx, pool, "5 fundLoan completion");
    t.wei(r.reserved, 15n * D, "5: completion reserves the principal");
    t.wei(r.balance, SUPPLY + 15n * D, "5: deposit + pending collateral - disbursed principal");
  }

  // 6 — withdrawal
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.withdraw(3n * D));
    const r = await check(t, ctx, pool, "6 withdrawal");
    t.wei(r.balance, SUPPLY - 3n * D, "6: the ETH left with the supplier");
  }

  // 7 — on-time repayment (fee to the treasury, net interest to the suppliers)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    const interest = simpleInterest(D, 1000n, 30n);
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    const r = await check(t, ctx, pool, "7 on-time repayment");
    t.wei(r.fees, feeOf(interest), "7: the fee is a separate treasury claim");
    t.wei(r.totalLiquidity, SUPPLY + interest - feeOf(interest), "7: suppliers gained exactly the net interest");
    t.wei(r.collateral, 0n, "7: the collateral went home to the borrower");
  }

  // 8 — late repayment (late fee joins the supplier claim)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await advancePastDue(ctx, pool, 1n, 900n);
    const { amountDue, lateFee } = await dueOf(pool, 1n);
    const interest = simpleInterest(D, 1000n, 30n);
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: amountDue }));
    const r = await check(t, ctx, pool, "8 late repayment");
    t.wei(r.totalLiquidity, SUPPLY + interest - feeOf(interest) + lateFee, "8: suppliers gained net interest + the whole late fee");
    t.wei(r.fees, feeOf(interest), "8: the treasury fee is unaffected by the late fee");
  }

  // 9 — withdraw after repayment (the pre-fix insolvency symptom)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    await ctx.send(pool.withdraw(await pool.sharesOf(a0)));
    const r = await check(t, ctx, pool, "9 full supplier exit after repayment");
    t.wei(await pool.totalShares(), 1n, "9: only the dead share is left");
    t.wei(r.balance, r.fees + 2n, "9: the pool is drained to exactly the treasury fee + 2 wei of rounding dust");
  }

  // 10 — excess-collateral liquidation
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: 3n * D });
    await advancePastDue(ctx, pool, 1n, 900n);
    await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    const r = await check(t, ctx, pool, "10 excess-collateral liquidation", { badDebt: 0n });
    t.wei(r.collateral, 0n, "10: all collateral was released");
    t.wei(r.reserved, 0n, "10: the reservation was released");
    t.gt(r.totalLiquidity, SUPPLY - D, "10: suppliers keep the principal claim and gain the penalty");
  }

  // 11 — bad-debt liquidation (suppliers absorb the shortfall)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setParams(10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 5_000n, 1_000n, 500n, 100n));
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D / 2n });
    await advancePastDue(ctx, pool, 1n, 900n);
    const { lateFee } = await dueOf(pool, 1n);
    const owed = D + simpleInterest(D, 1000n, 30n) + lateFee;
    await ctx.send(pool.connect(ctx.signer(4)).liquidate(1n));
    const expectedBadDebt = owed - D / 2n;
    const r = await check(t, ctx, pool, "11 bad-debt liquidation", { badDebt: expectedBadDebt });
    t.wei(r.totalLiquidity, SUPPLY - D + D / 2n, "11: the supplier claim falls by the uncovered principal");
    t.lt(r.totalLiquidity, SUPPLY, "11: suppliers are the residual claimant and take the loss");
    t.wei(r.reserved, 0n, "11: the reservation is released without underflow");
  }

  // 12 — cancelLoan
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 20n * D, collateral: 20n * D });
    await ctx.send(pool.connect(ctx.signer(1)).cancelLoan(1n));
    const r = await check(t, ctx, pool, "12 cancelLoan");
    t.wei(r.collateral, 0n, "12: the refunded collateral is no longer held");
    t.wei(r.balance, SUPPLY, "12: the pool is back to the supplier deposit");
  }

  // 13 — claimTreasury (fees leave the contract without touching the supplier claim)
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    const interest = simpleInterest(D, 1000n, 30n);
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    const tlBefore = await pool.totalLiquidity();
    await ctx.send(pool.claimTreasury(a0));
    const r = await check(t, ctx, pool, "13 claimTreasury");
    t.wei(r.fees, 0n, "13: the treasury claim is drained");
    t.wei(r.totalLiquidity, tlBefore, "13: supplier claims are untouched");
    t.wei(r.balance, SUPPLY + interest - feeOf(interest), "13: only the supplier backing is left in the contract");
  }

  // 14 — mixed book: pending + active + repaid loans in one pool
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await requestLoan(ctx, pool, 2, { principal: 20n * D, collateral: 20n * D }); // pending
    await requestLoan(ctx, pool, 3, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: 3n * D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    const r = await check(t, ctx, pool, "14 mixed loan book");
    t.wei(r.collateral, 20n * D + 3n * D, "14: pending + active collateral is held");
    t.wei(r.reserved, D, "14: only the active loan is reserved");
    t.gt(r.fees, 0n, "14: fees have accrued from the repayment");
  }

  // =====================================================================
  // 15 — the LITERAL (pre-amendment) rule-12 text is measured, not asserted
  // =====================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const stats = await pool.poolStats();
    const balance = await ctx.balance(pool.target);
    const literal = BigInt(stats[1]) + (await pool.accumulatedCollateral()) + BigInt(stats[8]) + 1n; // + DEAD_SHARES
    t.wei(literal - balance, 1n, "15: the literal rule-12 formula overshoots by exactly DEAD_SHARES after a bootstrap deposit");
    t.wei(await pool.DEAD_SHARES(), 1n, "15: the overshoot equals the declared DEAD_SHARES constant");

    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    const stats2 = await pool.poolStats();
    const balance2 = await ctx.balance(pool.target);
    const literal2 = BigInt(stats2[1]) + (await pool.accumulatedCollateral()) + BigInt(stats2[8]) + 1n;
    t.wei(
      literal2 - balance2,
      BigInt(stats2[3]) + 1n,
      "15: after activation the literal formula also overshoots by the reserved principal (+ DEAD_SHARES)"
    );
    t.check(
      balance2 === BigInt(stats2[1]) - BigInt(stats2[3]) + (await pool.accumulatedCollateral()) + BigInt(stats2[8]),
      "15: the AMENDED rule-12 identity holds exactly where the literal text does not"
    );
    t.wei(BigInt(stats2[3]), D, "15: the overshoot term is exactly reservedLiquidity");
  }
}

module.exports = { name: "13 money invariant (rule 12) after every scenario", run };
