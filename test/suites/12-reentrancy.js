"use strict";
/**
 * Suite 12 — Reentrancy guard (spec rule 10).
 *
 * A real attacker contract (test/attacker/ReentrancyProbe.sol, compiled at test time) re-enters
 * the pool from inside every ETH callback the pool makes and records the revert selector it sees.
 */
const path = require("path");
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, simpleInterest, advancePastDue } = require("./_helpers");

const PROBE_SOURCE = path.join(H.ROOT, "test", "attacker", "ReentrancyProbe.sol");
const REENTRANCY_SELECTOR = H.ethers.id("Reentrancy()").slice(0, 10);

async function probeStats(probe) {
  const [attempts, reverts, successes, data] = await Promise.all([
    probe.attempts(),
    probe.innerReverts(),
    probe.innerSuccesses(),
    probe.lastRevertData(),
  ]);
  return { attempts: BigInt(attempts), reverts: BigInt(reverts), successes: BigInt(successes), data: String(data) };
}

async function run(ctx, t) {
  const { contract } = H.compileSolidityFile(PROBE_SOURCE, "ReentrancyProbe");
  const abi = contract.abi;
  const bytecode = "0x" + contract.evm.bytecode.object;
  t.check(H.ethers.dataLength(bytecode) > 0, "the reentrancy probe contract compiles to non-empty bytecode");
  t.eq(REENTRANCY_SELECTOR.length, 10, "the Reentrancy() selector is a 4-byte value");

  const deployProbe = async (pool, deployer = 5) => {
    const factory = new H.ethers.ContractFactory(abi, bytecode, ctx.signer(deployer));
    const probe = await factory.deploy(pool.target);
    await probe.waitForDeployment();
    return probe;
  };

  const expectBlocked = async (label, before, after) => {
    t.wei(after.attempts - before.attempts, 1n, `${label}: the pool's ETH callback fired exactly once`);
    t.wei(after.reverts - before.reverts, 1n, `${label}: the re-entrant call reverted`);
    t.wei(after.successes - before.successes, 0n, `${label}: the re-entrant call never succeeded`);
    t.eq(after.data.slice(0, 10), REENTRANCY_SELECTOR, `${label}: the inner revert is Reentrancy()`);
  };

  // =====================================================================
  // A: re-enter every guarded function from inside withdraw()'s ETH transfer
  // =====================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const probe = await deployProbe(pool);
    // the probe owns the pool so claimTreasury() passes onlyOwner and reaches the guard
    await ctx.send(pool.transferOwnership(probe.target));
    t.eq(await pool.owner(), probe.target, "ownership moved to the probe so onlyOwner cannot mask the guard");

    const targets = {
      1: "withdraw()",
      2: "deposit()",
      3: "requestLoan()",
      4: "fundLoan()",
      5: "repayLoan()",
      6: "cancelLoan()",
      7: "liquidate()",
      8: "claimTreasury()",
    };
    for (let kind = 1; kind <= 8; kind++) {
      await ctx.send(probe.startDeposit(10n ** 17n, { value: 10n ** 17n }));
      const before = await probeStats(probe);
      await ctx.send(probe.startWithdraw(kind));
      const after = await probeStats(probe);
      await expectBlocked(`re-entering ${targets[kind]} during withdraw`, before, after);
    }
    t.wei(await pool.sharesOf(probe.target), 0n, "the outer withdrawals all completed and consumed the probe's shares");
    t.check(
      (await ctx.balance(pool.target)) ===
        (await pool.totalLiquidity()) - (await pool.reservedLiquidity()) +
          (await pool.accumulatedCollateral()) + (await pool.treasuryBalance()),
      "money invariant intact after the eight blocked re-entries"
    );
  }

  // =====================================================================
  // B: re-enter from the other six ETH callbacks the pool performs
  // =====================================================================
  {
    // B1 requestLoan -> principal disbursed to the borrower
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const probe = await deployProbe(pool);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe.target, value: 2n * D }));
    const before = await probeStats(probe);
    await ctx.send(probe.startRequestLoan(1, D, 1000n, 30n, { value: D }));
    const after = await probeStats(probe);
    await expectBlocked("re-entering withdraw during requestLoan's disbursement", before, after);
    t.wei((await pool.getLoan(1n)).status, 2n, "the outer requestLoan still activated normally");
    t.wei(await pool.reservedLiquidity(), D, "the outer requestLoan still reserved the principal");

    // B2 fundLoan -> activation pays the borrower
    const { pool: p2 } = await bootstrap(ctx, { supply: 0n, deposit: false });
    const probe2 = await deployProbe(p2);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe2.target, value: 2n * D }));
    await ctx.send(probe2.startRequestLoan(0, D, 1000n, 30n, { value: D })); // no liquidity -> Pending
    t.wei((await p2.getLoan(1n)).status, 1n, "the probe's request is pending with zero liquidity");
    const before2 = await probeStats(probe2);
    await ctx.send(probe2.startFundLoan(1, 1n, { value: D }));
    const after2 = await probeStats(probe2);
    await expectBlocked("re-entering withdraw during fundLoan's activation payout", before2, after2);
    t.wei((await p2.getLoan(1n)).status, 2n, "the outer fundLoan still activated the loan");

    // B3 repayLoan -> collateral returned to the borrower
    const { pool: p3 } = await bootstrap(ctx, { supply: SUPPLY });
    const probe3 = await deployProbe(p3);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe3.target, value: 5n * D }));
    await ctx.send(probe3.startRequestLoan(0, D, 1000n, 30n, { value: D }));
    const owed3 = (await dueOf(p3, 1n)).amountDue;
    const before3 = await probeStats(probe3);
    await ctx.send(probe3.startRepayLoan(1, 1n, { value: owed3 }));
    const after3 = await probeStats(probe3);
    await expectBlocked("re-entering withdraw during repayLoan's collateral refund", before3, after3);
    t.wei((await p3.getLoan(1n)).status, 3n, "the outer repayLoan still settled the loan");

    // B4 cancelLoan -> collateral refunded
    const { pool: p4 } = await bootstrap(ctx, { supply: 0n, deposit: false });
    const probe4 = await deployProbe(p4);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe4.target, value: 3n * D }));
    await ctx.send(probe4.startRequestLoan(0, D, 1000n, 30n, { value: D }));
    const before4 = await probeStats(probe4);
    await ctx.send(probe4.startCancelLoan(1, 1n));
    const after4 = await probeStats(probe4);
    await expectBlocked("re-entering withdraw during cancelLoan's refund", before4, after4);
    t.wei((await p4.getLoan(1n)).status, 5n, "the outer cancelLoan still cancelled the request");

    // B5 liquidate -> excess collateral refunded to the borrower
    const { pool: p5 } = await bootstrap(ctx, { supply: SUPPLY });
    const probe5 = await deployProbe(p5);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe5.target, value: 5n * D }));
    await ctx.send(probe5.startRequestLoan(0, D, 1000n, 30n, { value: 3n * D }));
    await advancePastDue(ctx, p5, 1n, 900n);
    const before5 = await probeStats(probe5);
    await ctx.send(probe5.startLiquidate(1, 1n));
    const after5 = await probeStats(probe5);
    await expectBlocked("re-entering withdraw during liquidate's refund", before5, after5);
    t.wei((await p5.getLoan(1n)).status, 4n, "the outer liquidate still settled the loan");

    // B6 claimTreasury -> fee paid out to the recipient
    const { pool: p6 } = await bootstrap(ctx, { supply: SUPPLY });
    const probe6 = await deployProbe(p6);
    const interest = simpleInterest(D, 1000n, 30n);
    await requestLoan(ctx, p6, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    await ctx.send(p6.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(p6, 1n)).amountDue }));
    await ctx.send(p6.transferOwnership(probe6.target));
    t.wei(await p6.treasuryBalance(), (interest * 1000n) / BPS, "a fee is waiting to be claimed");
    const before6 = await probeStats(probe6);
    await ctx.send(probe6.startClaimTreasury(1, probe6.target));
    const after6 = await probeStats(probe6);
    await expectBlocked("re-entering withdraw during claimTreasury's payout", before6, after6);
    t.wei(await p6.treasuryBalance(), 0n, "the outer claimTreasury still paid out the fee");
  }

  // =====================================================================
  // C: the guard does not break legitimate sequential use
  // =====================================================================
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const probe = await deployProbe(pool);
    await ctx.send(ctx.signer(9).sendTransaction({ to: probe.target, value: 2n * D }));
    await ctx.send(probe.startDeposit(D, { value: D }));
    t.gt(await pool.sharesOf(probe.target), 0n, "the probe can deposit normally when not re-entering");
    const shares = await pool.sharesOf(probe.target);
    const before = await probeStats(probe);
    await ctx.send(probe.startWithdraw(0)); // kind 0 is not a re-entry target: plain withdraw
    const after = await probeStats(probe);
    t.wei(after.attempts - before.attempts, 0n, "the control withdrawal makes no re-entry attempt");
    t.wei(after.reverts - before.reverts, 0n, "the control withdrawal sees no guard revert");
    t.wei(await pool.sharesOf(probe.target), 0n, "the plain withdrawal burned all the probe's shares");
    t.check((await ctx.balance(pool.target)) ===
      (await pool.totalLiquidity()) - (await pool.reservedLiquidity()) +
      (await pool.accumulatedCollateral()) + (await pool.treasuryBalance()),
      "money invariant after the non-reentrant control flow");
    t.gt(shares, 0n, "the probe held shares before the control withdrawal");
  }
}

module.exports = { name: "12 reentrancy guard (live attacker contract)", run };
