"use strict";
/**
 * Suite 09 — Governance and access control.
 * Spec rule 11 + the owner-only surface (setParams / setPaused / setTreasury /
 * transferOwnership / claimTreasury) and initialisation front-running.
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, simpleInterest } = require("./_helpers");

const VALID = [10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n];

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);

  // ================= access control: every owner-only entry point =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const outsider = pool.connect(ctx.signer(5));
    const cases = [
      ["setParams(...)", () => outsider.setParams.staticCall(...VALID)],
      ["setPaused(true)", () => outsider.setPaused.staticCall(true)],
      ["setTreasury(...)", () => outsider.setTreasury.staticCall(ctx.addressOf(5))],
      ["transferOwnership(...)", () => outsider.transferOwnership.staticCall(ctx.addressOf(5))],
      ["claimTreasury(...)", () => outsider.claimTreasury.staticCall(ctx.addressOf(5))],
    ];
    for (const [label, thunk] of cases) {
      await t.reverts(thunk, "NotOwner", [], `${label} from a non-owner reverts NotOwner`);
    }
    // once ownership moves, the previous owner loses access
    await ctx.send(pool.transferOwnership(ctx.addressOf(5)));
    await t.reverts(() => pool.setPaused.staticCall(true), "NotOwner", [], "the previous owner loses control after transferOwnership");
    await t.reverts(() => pool.setParams.staticCall(...VALID), "NotOwner", [], "the previous owner cannot call setParams");
    await ctx.send(pool.connect(ctx.signer(5)).setPaused(true));
    t.eq(await pool.paused(), true, "the new owner can administer the pool");
  }

  // ================= setParams validation matrix =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const bad = [
      ["minDeposit == 0", [0n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n], "minDeposit"],
      ["minLoanPrincipal == 0", [10n ** 12n, 0n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n], "minLoanPrincipal"],
      ["maxLoanPrincipal < minLoanPrincipal", [10n ** 12n, 10n ** 15n, 10n ** 14n, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n], "maxLoanPrincipal"],
      ["maxDurationDays == 0", [10n ** 12n, 10n ** 13n, 100n * D, 0n, 5_000n, 10_000n, 1_000n, 500n, 100n], "maxDurationDays"],
      ["maxRateBps == 0", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 0n, 10_000n, 1_000n, 500n, 100n], "maxRateBps"],
      ["maxRateBps > 10000", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 10_001n, 10_000n, 1_000n, 500n, 100n], "maxRateBps"],
      ["minCollateralBps < 5000 floor", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 4_999n, 1_000n, 500n, 100n], "minCollateralBps"],
      ["feeBps > 2000", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 2_001n, 500n, 100n], "feeBps"],
      ["penaltyBps > 2000", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 2_001n, 100n], "penaltyBps"],
      ["lateFeeBps > 2000", [10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 2_001n], "lateFeeBps"],
    ];
    for (const [label, args, param] of bad) {
      await t.reverts(
        () => pool.setParams.staticCall(...args),
        "InvalidParameter",
        [param],
        `setParams rejects ${label} with InvalidParameter("${param}")`
      );
    }
    // the values were not partially applied by any rejected call
    t.wei(await pool.feeBps(), 1_000n, "a rejected setParams leaves feeBps untouched");
    t.wei(await pool.minCollateralBps(), 10_000n, "a rejected setParams leaves minCollateralBps untouched");
    t.wei(await pool.maxLoanPrincipal(), 100n * D, "a rejected setParams leaves maxLoanPrincipal untouched");
  }

  // ================= setParams boundaries + event =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    // exact ceilings are accepted
    const ceilings = [10n ** 12n, 10n ** 13n, 100n * D, 365n, 10_000n, 20_000n, 2_000n, 2_000n, 2_000n];
    const receipt = await ctx.send(pool.setParams(...ceilings));
    t.event(receipt, pool, "ParamsUpdated", ceilings, "ParamsUpdated echoes all nine parameters in order");
    t.wei(await pool.feeBps(), 2_000n, "feeBps == MAX_FEE_BPS is accepted");
    t.wei(await pool.penaltyBps(), 2_000n, "penaltyBps == MAX_PENALTY_BPS is accepted");
    t.wei(await pool.lateFeeBps(), 2_000n, "lateFeeBps == MAX_LATE_FEE_BPS is accepted");
    t.wei(await pool.maxRateBps(), 10_000n, "maxRateBps == BPS_DENOMINATOR (100% APR) is accepted");
    t.wei(await pool.minCollateralBps(), 20_000n, "minCollateralBps has no upper cap: 20_000 (200%) is accepted");
    t.wei(await pool.maxDurationDays(), 365n, "maxDurationDays updates");

    // the floor itself is accepted, one below is not
    const floor = [1n, 1n, 100n * D, 365n, 5_000n, 5_000n, 1_000n, 500n, 100n];
    await ctx.send(pool.setParams(...floor));
    t.wei(await pool.minCollateralBps(), 5_000n, "minCollateralBps == MIN_COLLATERAL_FLOOR_BPS (5_000) is accepted");
    t.wei(await pool.minDeposit(), 1n, "the new minDeposit is applied verbatim");
    await t.reverts(
      () => pool.setParams.staticCall(1n, 1n, 100n * D, 365n, 5_000n, 4_999n, 1_000n, 500n, 100n),
      "InvalidParameter",
      ["minCollateralBps"],
      "minCollateralBps one below the floor is rejected"
    );
  }

  // ================= setPaused / setTreasury / transferOwnership events =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const p1 = await ctx.send(pool.setPaused(true));
    t.event(p1, pool, "PausedSet", [true], "setPaused(true) emits PausedSet(true)");
    t.eq(await pool.paused(), true, "setPaused(true) sets the flag");
    const p2 = await ctx.send(pool.setPaused(false));
    t.event(p2, pool, "PausedSet", [false], "setPaused(false) emits PausedSet(false)");
    t.eq(await pool.paused(), false, "setPaused(false) clears the flag");

    await t.reverts(() => pool.setTreasury.staticCall(H.ZERO_ADDRESS), "ZeroAddress", [], "setTreasury(0x0) reverts ZeroAddress");
    const tr = await ctx.send(pool.setTreasury(a1));
    t.event(tr, pool, "TreasurySet", [a1], "setTreasury emits TreasurySet(newTreasury)");
    t.eq(await pool.treasury(), a1, "setTreasury updates the treasury");

    await t.reverts(() => pool.transferOwnership.staticCall(H.ZERO_ADDRESS), "ZeroAddress", [], "transferOwnership(0x0) reverts ZeroAddress");
    const own = await ctx.send(pool.transferOwnership(a1));
    t.event(own, pool, "OwnershipTransferred", [a0, a1], "transferOwnership emits OwnershipTransferred(previous, new)");
    t.eq(await pool.owner(), a1, "transferOwnership updates the owner");
  }

  // ================= claimTreasury =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.claimTreasury.staticCall(H.ZERO_ADDRESS), "ZeroAddress", [], "claimTreasury(0x0) reverts ZeroAddress even before the NoFees check");
    await t.reverts(() => pool.claimTreasury.staticCall(a0), "NoFees", [], "claimTreasury with no accrued fees reverts NoFees");

    // build a real fee: repay a loan
    const interest = simpleInterest(D, 1000n, 30n);
    const fee = (interest * 1_000n) / BPS;
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    t.wei(await pool.treasuryBalance(), fee, "a repayment accrues exactly fee = interest * feeBps / 10000");
    t.wei(await pool.totalFeesCollected(), fee, "totalFeesCollected tracks the lifetime fee");

    const tlBefore = await pool.totalLiquidity();
    const recipientBefore = await ctx.balance(a1);
    const receipt = await ctx.send(pool.claimTreasury(a1));
    t.event(receipt, pool, "TreasuryClaimed", [a1, fee], "TreasuryClaimed(to, amount) pays the full accrued fee");
    t.wei((await ctx.balance(a1)) - recipientBefore, fee, "the recipient receives the exact fee amount");
    t.wei(await pool.treasuryBalance(), 0n, "treasuryBalance is drained");
    t.wei(await pool.totalLiquidity(), tlBefore, "claimTreasury does NOT reduce supplier claims (the fee was never inside totalLiquidity)");
    t.eq(
      (await ctx.balance(pool.target)) ===
        (await pool.totalLiquidity()) - (await pool.reservedLiquidity()) +
          (await pool.accumulatedCollateral()) + (await pool.treasuryBalance()),
      true,
      "money invariant after claimTreasury"
    );
    await t.reverts(() => pool.claimTreasury.staticCall(a1), "NoFees", [], "claiming twice reverts NoFees");
  }

  // ================= claimTreasury is capped by free liquidity =================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setParams(10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n));
    const interest = simpleInterest(D, 1000n, 30n);
    const fee = (interest * 1_000n) / BPS;
    await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(pool, 1n)).amountDue }));
    t.wei(await pool.treasuryBalance(), fee, "the pool holds a fee to claim");

    // reserve everything except 1 wei so the cap is exercised deterministically
    const available = BigInt((await pool.poolStats())[2]);
    t.gt(available, 1n, "free liquidity exceeds 1 wei before reserving");
    await requestLoan(ctx, pool, 2, { principal: available - 1n, collateral: available - 1n, rateBps: 0n, durationDays: 1n });
    t.wei((await pool.poolStats())[2], 1n, "only 1 wei of free liquidity is left");

    const receipt = await ctx.send(pool.claimTreasury(a1));
    t.event(receipt, pool, "TreasuryClaimed", [a1, 1n], "claimTreasury is capped at availableLiquidity (1 wei)");
    t.wei(await pool.treasuryBalance(), fee - 1n, "only the capped amount leaves treasuryBalance");
    t.check((await pool.totalLiquidity()) >= (await pool.reservedLiquidity()), "reservedLiquidity <= totalLiquidity still holds");
  }

  // ================= initialisation front-running (documented limitation) =================
  {
    const fresh = await ctx.deploy({ initialize: false });
    t.eq(await fresh.initialized(), false, "a freshly deployed pool is un-initialised");
    // an unrelated account grabs ownership first
    await ctx.send(fresh.connect(ctx.signer(7)).initialize(ctx.addressOf(7), ctx.addressOf(7)));
    t.eq(await fresh.owner(), ctx.addressOf(7), "the FIRST caller of initialize() becomes the owner (front-running is possible)");
    t.eq(await fresh.treasury(), ctx.addressOf(7), "the first caller also sets the treasury");
    await t.reverts(
      () => fresh.initialize.staticCall(a0, a0),
      "AlreadyInitialized",
      [],
      "the legitimate deployer can no longer initialize: first-caller-wins is a documented known limitation"
    );
    t.eq(await fresh.initialized(), true, "the grabbed pool stays initialised and usable by the attacker");
  }
}

module.exports = { name: "09 governance + access control", run };
