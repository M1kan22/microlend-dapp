"use strict";
/**
 * Suite 03 — Supplier withdrawals.
 * Spec rule 3: ZeroAmount / InsufficientShares / allowed while paused / reserved-liquidity lock,
 * plus the economic property that shares appreciate by exactly the net interest.
 */
const { H, D, SUPPLY, BPS, bootstrap, requestLoan, dueOf, simpleInterest } = require("./_helpers");

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);

  // ---------------- rule 3: validation ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.withdraw.staticCall(0n), "ZeroAmount", [], "withdraw(0) reverts ZeroAmount");
    await t.reverts(
      () => pool.withdraw.staticCall(SUPPLY),
      "InsufficientShares",
      [SUPPLY, SUPPLY - 1n],
      "withdraw(more than owned) reverts InsufficientShares(requested, owned)"
    );
    await t.reverts(
      () => pool.connect(ctx.signer(4)).withdraw.staticCall(1n),
      "InsufficientShares",
      [1n, 0n],
      "withdraw from a wallet with no shares reverts InsufficientShares(requested, 0)"
    );
  }

  // ---------------- rule 3: exact burn/return accounting ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const shares = await pool.sharesOf(a0);
    const balanceBefore = await ctx.balance(a0);
    const receipt = await ctx.send(pool.withdraw(shares));
    const balanceAfter = await ctx.balance(a0);
    const gas = receipt.gasUsed * receipt.gasPrice;

    t.wei(balanceAfter - balanceBefore, shares - gas, "a 1:1 share burn returns exactly shares wei (net of gas)");
    t.event(receipt, pool, "LiquidityWithdrawn", [a0, shares, shares], "LiquidityWithdrawn emits (supplier, sharesBurned, amountReturned)");
    t.wei(await pool.sharesOf(a0), 0n, "the caller's share balance is zeroed");
    t.wei(await pool.totalShares(), 1n, "totalShares drops back to the parked DEAD_SHARES only");
    t.wei(await pool.totalLiquidity(), 1n, "totalLiquidity drops to the 1 wei the dead share represents");
    t.wei(await ctx.balance(pool.target), 1n, "the contract keeps exactly the dead share's wei");

    // partial withdrawal leaves the rest intact (minDeposit must be respected)
    await ctx.send(pool.connect(ctx.signer(1)).deposit({ value: 10n ** 12n }));
    const a1Shares = await pool.sharesOf(a1);
    t.wei(a1Shares, 10n ** 12n, "the second depositor mints exactly minDeposit shares at a 1:1 price");
    await ctx.send(pool.connect(ctx.signer(1)).withdraw(a1Shares - 1n));
    t.wei(await pool.sharesOf(a1), 1n, "partial withdraw burns only the requested shares");
    t.wei(await pool.convertToAssets(1n), 1n, "the remaining share is still worth its 1 wei");
  }

  // ---------------- rule 3: withdraw stays available while paused ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(pool.setPaused(true));
    t.eq((await pool.poolStats())[11], true, "poolStats reports paused == true");
    const shares = await pool.sharesOf(a0);
    const balanceBefore = await ctx.balance(a0);
    const receipt = await ctx.send(pool.withdraw(2n * D));
    const gas = receipt.gasUsed * receipt.gasPrice;
    t.wei((await ctx.balance(a0)) - balanceBefore, 2n * D - gas, "withdraw() succeeds while paused (users can always exit)");
    t.event(receipt, pool, "LiquidityWithdrawn", [a0, 2n * D, 2n * D], "the paused withdrawal still emits correct amounts");
    t.eq(await pool.paused(), true, "withdrawing does not unpause the pool");
    t.wei(await pool.sharesOf(a0), shares - 2n * D, "paused withdrawal burns exactly the requested shares");
  }

  // ---------------- rule 3: liquidity reserved for active loans is untouchable ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 8n * D, collateral: 8n * D });
    const stats = await pool.poolStats();
    t.wei(stats[2], 2n * D, "available liquidity is 2 ETH after an 8 ETH loan is reserved");
    t.wei(stats[3], 8n * D, "reservedLiquidity holds the outstanding principal");
    const shares = await pool.sharesOf(a0);
    const requested = 9n * D;
    const assets = await pool.convertToAssets(requested);
    await t.reverts(
      () => pool.withdraw.staticCall(requested),
      "InsufficientLiquidity",
      [assets, 2n * D],
      "withdraw(9 ETH of shares) reverts InsufficientLiquidity(assets, available = 2 ETH)"
    );
    // exactly at the free-liquidity boundary it works
    const okReceipt = await ctx.send(pool.withdraw(2n * D));
    t.event(okReceipt, pool, "LiquidityWithdrawn", [a0, 2n * D, 2n * D], "withdraw(available) succeeds exactly at the boundary");
    t.wei((await pool.poolStats())[2], 0n, "free liquidity is exhausted afterwards");
    t.wei(await pool.reservedLiquidity(), 8n * D, "the reservation itself is untouched by supplier exits");
    t.wei(await pool.sharesOf(a0), shares - 2n * D, "the boundary withdrawal burned only its own shares");
  }

  // ---------------- shares appreciate by exactly the net interest ----------------
  // (regression for the settlement double-count: the ONLY supplier must be able to exit fully)
  {
    const principal = D;
    const rateBps = 1000n;
    const days = 30n;
    const interest = simpleInterest(principal, rateBps, days);
    const fee = (interest * 1000n) / BPS;
    const netInterest = interest - fee;

    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal, rateBps, durationDays: days, collateral: principal });
    const { amountDue, lateFee } = await dueOf(pool, 1n);
    t.wei(lateFee, 0n, "an on-time repayment has no late fee");
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: amountDue }));

    const expectedClaim = SUPPLY + netInterest;
    t.wei(await pool.totalLiquidity(), expectedClaim, "totalLiquidity grows by exactly the net interest after repayment");
    t.wei(await pool.totalInterestEarned(), interest, "totalInterestEarned records the gross interest charged");
    t.wei(await pool.treasuryBalance(), fee, "the protocol fee lands in treasuryBalance and never in totalLiquidity");

    const shares = await pool.sharesOf(a0);
    const expectedAssets = (shares * expectedClaim) / SUPPLY;
    const dust = expectedClaim - expectedAssets;
    t.wei(await pool.convertToAssets(shares), expectedAssets, "supplier share value == floor(shares * (deposit + netInterest) / totalShares)");
    t.wei(await pool.sharePrice(), (expectedClaim * D) / SUPPLY, "sharePrice() == totalLiquidity * 1e18 / totalShares");
    t.gt(await pool.sharePrice(), D, "share price is above 1:1 once interest has been repaid");

    // The sole supplier redeems everything: this is the user-visible symptom of the settlement bug.
    const balanceBefore = await ctx.balance(a0);
    const receipt = await ctx.send(pool.withdraw(shares));
    const gas = receipt.gasUsed * receipt.gasPrice;
    t.event(receipt, pool, "LiquidityWithdrawn", [a0, shares, expectedAssets], "the sole supplier's full exit succeeds with the exact assets");
    t.wei((await ctx.balance(a0)) - balanceBefore, expectedAssets - gas, "the supplier exits with exactly deposit + net interest (floor)");
    t.wei(expectedAssets - SUPPLY, netInterest - 2n, "supplier profit == netInterest - 2 wei of rounding (exact wei)");
    t.wei(await pool.totalShares(), 1n, "only the dead share remains after the full exit");
    t.wei(await pool.totalLiquidity(), dust, "the dust left in totalLiquidity is exactly the rounding remainder");
    t.wei(dust, 2n, "the rounding remainder is exactly 2 wei");
    t.wei(await pool.reservedLiquidity(), 0n, "nothing is reserved after the loan is repaid");
    t.wei(await ctx.balance(pool.target), dust + fee, "the pool drains to exactly treasuryBalance + rounding dust");
    t.eq(
      (await ctx.balance(pool.target)) ===
        (await pool.totalLiquidity()) - (await pool.reservedLiquidity()) +
          (await pool.accumulatedCollateral()) +
          (await pool.treasuryBalance()),
      true,
      "money invariant after the sole supplier's full exit"
    );
  }
}

module.exports = { name: "03 withdraw (paused exit, share burn, reserved lock)", run };
