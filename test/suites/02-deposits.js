"use strict";
/**
 * Suite 02 — Supplier deposits: share minting, DEAD_SHARES inflation guard, donation safety.
 * Spec rule 1, rule 2 and the share accounting paragraph in section 1.
 */
const { H, D, SUPPLY, bootstrap } = require("./_helpers");

const MIN_DEPOSIT = 10n ** 12n;

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);

  // ---------------- rule 1: minDeposit + paused ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false });
    await t.reverts(() => pool.deposit.staticCall({ value: 0n }), "ZeroAmount", [], "deposit() with 0 wei reverts ZeroAmount");
    await t.reverts(
      () => pool.deposit.staticCall({ value: MIN_DEPOSIT - 1n }),
      "AmountTooSmall",
      [MIN_DEPOSIT - 1n, MIN_DEPOSIT],
      "first deposit below minDeposit reverts AmountTooSmall(value, minDeposit)"
    );
    await t.reverts(
      () => pool.connect(ctx.signer(1)).deposit.staticCall({ value: 10n ** 9n }),
      "AmountTooSmall",
      [10n ** 9n, MIN_DEPOSIT],
      "deposit(0.000000001 ETH) from another wallet reverts AmountTooSmall with the same minimum"
    );
    await ctx.send(pool.setPaused(true));
    await t.reverts(
      () => pool.deposit.staticCall({ value: D }),
      "PoolPaused",
      [],
      "deposit() while paused reverts PoolPaused"
    );
  }

  // ---------------- rule 1: bootstrap mint of value - 1 shares + 1 dead share ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false });
    const depositReceipt = await ctx.send(pool.deposit({ value: SUPPLY }));

    t.wei(await pool.sharesOf(a0), SUPPLY - 1n, "first deposit mints exactly value - DEAD_SHARES shares to the depositor");
    t.wei(await pool.totalShares(), SUPPLY, "totalShares after the bootstrap deposit == deposited value (dead share included)");
    t.wei(
      (await pool.totalShares()) - (await pool.sharesOf(a0)),
      1n,
      "exactly DEAD_SHARES == 1 share stays on the contract (nobody owns it)"
    );
    t.wei(await pool.totalLiquidity(), SUPPLY, "totalLiquidity == deposited value");
    t.wei(await pool.totalDeposited(), SUPPLY, "totalDeposited == deposited value");
    t.wei(await pool.sharePrice(), D, "share price is exactly 1e18 (1 share == 1 wei) after bootstrap");
    t.event(
      depositReceipt,
      pool,
      "LiquidityDeposited",
      [a0, SUPPLY, SUPPLY - 1n],
      "LiquidityDeposited emits (supplier, amount, sharesMinted = amount - 1)"
    );
    t.wei(await ctx.balance(pool.target), SUPPLY, "the contract holds exactly the deposited ETH");

    // The dead share is real, backed ETH: withdrawing everything leaves exactly 1 wei behind.
    await ctx.send(pool.withdraw(SUPPLY - 1n));
    t.wei(await pool.totalShares(), 1n, "after the bootstrap depositor exits, only the DEAD_SHARES supply remains");
    t.wei(await ctx.balance(pool.target), 1n, "the contract then holds exactly DEAD_SHARES wei (no hidden extra wei)");
    t.wei(await pool.totalLiquidity(), 1n, "totalLiquidity == 1 wei == the dead share");
  }

  // ---------------- rule 1: the DEAD_SHARES bootstrap branch itself ----------------
  {
    const { pool } = await bootstrap(ctx, { deposit: false });
    await ctx.send(pool.setParams(1n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n));
    await t.reverts(
      () => pool.deposit.staticCall({ value: 1n }),
      "AmountTooSmall",
      [1n, 2n],
      "first deposit of exactly DEAD_SHARES wei reverts AmountTooSmall(value, DEAD_SHARES + 1)"
    );
    const ok = await ctx.send(pool.deposit({ value: 2n }));
    t.wei(await pool.sharesOf(a0), 1n, "first deposit of 2 wei mints 1 share (dead-share bootstrap path)");
    t.event(ok, pool, "LiquidityDeposited", [a0, 2n, 1n], "bootstrap path still emits the exact sharesMinted");
  }

  // ---------------- second depositor share math ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY, depositor: 0 });
    const expectedShares = (5n * D * (await pool.totalShares())) / (await pool.totalLiquidity());
    t.wei(expectedShares, 5n * D, "with a 1:1 price the pro-rata formula yields exactly the deposited wei");
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).deposit({ value: 5n * D }));
    t.wei(await pool.sharesOf(a1), expectedShares, "second depositor mints floor(assets * totalShares / totalLiquidity) shares");
    t.event(receipt, pool, "LiquidityDeposited", [a1, 5n * D, expectedShares], "second LiquidityDeposited carries the exact share count");
    t.wei(await pool.totalShares(), SUPPLY + expectedShares, "totalShares sums both depositors plus the dead share");
    t.wei(await pool.totalLiquidity(), SUPPLY + 5n * D, "totalLiquidity sums both deposits");
    t.wei(await pool.totalDeposited(), SUPPLY + 5n * D, "totalDeposited is a lifetime accumulator");
    t.wei(await pool.sharePrice(), D, "share price is still 1e18 while nobody has earned interest");
  }

  // ---------------- rule 2: receive()/fallback() reject plain ETH ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const balanceBefore = await ctx.balance(pool.target);
    const sharesBefore = await pool.totalShares();

    // NOTE: ganache drops revert data when an eth_call carries a non-zero value, so the
    // custom-error decoding checks use value 0. `receive()`/`fallback()` revert unconditionally,
    // and the real value-carrying transaction is asserted separately below.
    const call = await ctx.callRaw({ to: pool.target, value: 0n, data: "0x" });
    t.check(!call.ok, "a call with empty calldata hits receive() and is rejected by the EVM");
    const decoded = call.ok ? null : H.decodeCustomError(call.err, t.iface);
    t.check(!!decoded && decoded.name === "ZeroAmount", "receive() reverts with custom error ZeroAmount", decoded ? decoded.name : H.oneLine(call.err));

    const fallbackCall = await ctx.callRaw({ to: pool.target, value: 0n, data: "0xdeadbeef" });
    const fallbackDecoded = fallbackCall.ok ? null : H.decodeCustomError(fallbackCall.err, t.iface);
    t.check(!!fallbackDecoded && fallbackDecoded.name === "ZeroAmount", "unknown selector (fallback) reverts with ZeroAmount", fallbackDecoded ? fallbackDecoded.name : H.oneLine(fallbackCall.err));

    // A real, signed, value-carrying transaction with a forced gas limit: ganache rejects the
    // RPC call, so the transaction hash is recovered from the error and the receipt inspected.
    let receipt = null;
    let waitError = null;
    let hash = null;
    try {
      const tx = await ctx.signer(2).sendTransaction({ to: pool.target, value: D, gasLimit: 100_000n });
      hash = tx.hash;
      receipt = await tx.wait();
    } catch (err) {
      waitError = err;
      hash = err?.error?.data?.hash || err?.data?.hash || err?.receipt?.hash || err?.transaction?.hash || null;
      if (hash) receipt = await ctx.provider.getTransactionReceipt(hash);
    }
    t.check(!!receipt && receipt.status === 0, "a real signed ETH transfer to the pool is mined with status 0", waitError ? `${H.oneLine(waitError)} (hash=${hash})` : `status=${receipt && receipt.status}`);
    t.wei(await ctx.balance(pool.target), balanceBefore, "the rejected donation leaves the pool balance untouched");
    t.wei(await pool.totalShares(), sharesBefore, "the rejected donation mints no shares");
    t.wei(await pool.convertToAssets(sharesBefore), SUPPLY, "share value is unchanged by the rejected donation");
  }

  // ---------------- inflation-attack resistance ----------------
  {
    // The classic first-depositor grief: attacker deposits 1 wei and then donates a large amount
    // so the victim's shares round to zero. Donations are impossible (receive reverts), and the
    // dead share keeps the price at 1 wei/share, so the attacker cannot mint value.
    const { pool } = await bootstrap(ctx, { supply: SUPPLY, depositor: 0 });
    await ctx.send(pool.setParams(1n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 1_000n, 500n, 100n));

    const victimDeposit = 1n;
    await ctx.send(pool.connect(ctx.signer(1)).deposit({ value: victimDeposit }));
    const victimShares = await pool.sharesOf(a1);
    const victimAssets = await pool.convertToAssets(victimShares);
    t.wei(victimShares, 1n, "with minDeposit lowered, a 1 wei deposit still mints 1 share (price is exactly 1:1)");
    t.wei(victimAssets, 1n, "the victim can redeem the same 1 wei back — no rounding loss for a 1 wei deposit");
    t.lte(victimAssets, victimDeposit, "a donation-style deposit can never be worth more than it paid");

    // Attacker tries to donate to skew the price: the receive hook rejects it.
    const donated = await ctx.callRaw({ to: pool.target, value: 100n * D, data: "0x" });
    t.check(!donated.ok, "attacker cannot donate 100 ETH to inflate the share price (receive() rejects it)");
    t.wei(await ctx.balance(pool.target), SUPPLY + 1n, "the blocked donation left the pool balance at deposit + 1 wei");
    t.wei(await pool.convertToAssets(victimShares), 1n, "victim share value is untouched after the blocked donation attempt");

    // The bootstrap depositor is not diluted by the 1 wei depositor.
    const firstShares = await pool.sharesOf(a0);
    const firstAssets = await pool.convertToAssets(firstShares);
    t.gte(firstAssets, SUPPLY - 1n, "bootstrap depositor keeps at least the principle of their shares");
  }
}

module.exports = { name: "02 deposits + share math + donation safety", run };
