"use strict";
/**
 * Suite 04 — requestLoan validation matrix.
 * Spec rule 4: principal bounds, duration bounds, rate ceiling, ceil() collateral requirement.
 */
const { H, D, SUPPLY, bootstrap, requestLoan, simpleInterest } = require("./_helpers");

const MIN_PRINCIPAL = 10n ** 13n;
const MAX_PRINCIPAL = 100n * D;

async function run(ctx, t) {
  const a1 = ctx.addressOf(1);
  const { pool } = await bootstrap(ctx, { supply: SUPPLY });
  const borrower = pool.connect(ctx.signer(1));

  // ---------------- zero amount branches ----------------
  await t.reverts(
    () => borrower.requestLoan.staticCall(0n, 1000n, 30n, { value: D }),
    "ZeroAmount",
    [],
    "requestLoan(principal = 0) reverts ZeroAmount"
  );
  await t.reverts(
    () => borrower.requestLoan.staticCall(D, 1000n, 30n, { value: 0n }),
    "ZeroAmount",
    [],
    "requestLoan without collateral (msg.value = 0) reverts ZeroAmount"
  );

  // ---------------- principal bounds ----------------
  await t.reverts(
    () => borrower.requestLoan.staticCall(MIN_PRINCIPAL - 1n, 1000n, 30n, { value: MIN_PRINCIPAL - 1n }),
    "AmountTooSmall",
    [MIN_PRINCIPAL - 1n, MIN_PRINCIPAL],
    "principal below minLoanPrincipal reverts AmountTooSmall(principal, minLoanPrincipal)"
  );
  await t.reverts(
    () => borrower.requestLoan.staticCall(MAX_PRINCIPAL + 1n, 1000n, 30n, { value: MAX_PRINCIPAL + 1n }),
    "AmountTooLarge",
    [MAX_PRINCIPAL + 1n, MAX_PRINCIPAL],
    "principal above maxLoanPrincipal reverts AmountTooLarge(principal, maxLoanPrincipal)"
  );

  // ---------------- duration bounds ----------------
  await t.reverts(
    () => borrower.requestLoan.staticCall(D, 1000n, 0n, { value: D }),
    "DurationInvalid",
    [0n, 365n],
    "durationDays == 0 reverts DurationInvalid(0, maxDurationDays)"
  );
  await t.reverts(
    () => borrower.requestLoan.staticCall(D, 1000n, 366n, { value: D }),
    "DurationInvalid",
    [366n, 365n],
    "durationDays above maxDurationDays reverts DurationInvalid(duration, maxDurationDays)"
  );

  // ---------------- rate ceiling ----------------
  await t.reverts(
    () => borrower.requestLoan.staticCall(D, 5001n, 30n, { value: D }),
    "RateTooHigh",
    [5001n, 5000n],
    "rateBps above maxRateBps reverts RateTooHigh(rateBps, maxRateBps)"
  );

  // ---------------- collateral requirement: ceil(principal * minCollateralBps / 10000) ----------------
  await t.reverts(
    () => borrower.requestLoan.staticCall(D, 1000n, 30n, { value: D - 1n }),
    "InsufficientCollateral",
    [D - 1n, D],
    "collateral 1 wei short of the 100% requirement reverts InsufficientCollateral(provided, required)"
  );
  await t.reverts(
    () => borrower.requestLoan.staticCall(5n * D, 1000n, 30n, { value: 4n * D }),
    "InsufficientCollateral",
    [4n * D, 5n * D],
    "collateral of 80% of principal reverts InsufficientCollateral with exact required amount"
  );

  // ---------------- inclusive boundaries are accepted ----------------
  {
    const okMin = await requestLoan(ctx, pool, 1, { principal: MIN_PRINCIPAL, rateBps: 0n, durationDays: 1n, collateral: MIN_PRINCIPAL });
    t.wei(okMin.loan.principal, MIN_PRINCIPAL, "principal == minLoanPrincipal is accepted");
    const okDuration = await requestLoan(ctx, pool, 1, { principal: D, rateBps: 0n, durationDays: 365n, collateral: D });
    t.wei(okDuration.loan.durationDays, 365n, "durationDays == maxDurationDays is accepted");
    const okRate = await requestLoan(ctx, pool, 1, { principal: D, rateBps: 5000n, durationDays: 30n, collateral: D });
    t.wei(okRate.loan.rateBps, 5000n, "rateBps == maxRateBps is accepted");
    const okExact = await requestLoan(ctx, pool, 1, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    t.wei(okExact.loan.collateral, D, "collateral exactly == ceil(principal * minCollateralBps / 10_000) is accepted");
    const okMax = await requestLoan(ctx, pool, 1, { principal: MAX_PRINCIPAL, rateBps: 0n, durationDays: 1n, collateral: MAX_PRINCIPAL });
    t.wei(okMax.loan.principal, MAX_PRINCIPAL, "principal == maxLoanPrincipal is accepted");
  }

  // ---------------- ceil() rounding of the collateral requirement ----------------
  {
    const { pool: p } = await bootstrap(ctx, { supply: SUPPLY });
    // minCollateralBps = 10_001 (100.01%) with a 3 wei principal gives required == 4 wei.
    await ctx.send(p.setParams(1n, 3n, MAX_PRINCIPAL, 365n, 5_000n, 10_001n, 1_000n, 500n, 100n));
    t.wei((await p.minCollateralBps()), 10_001n, "owner can raise minCollateralBps above 100% (no upper cap in setParams)");

    await t.reverts(
      () => p.connect(ctx.signer(1)).requestLoan.staticCall(3n, 0n, 1n, { value: 3n }),
      "InsufficientCollateral",
      [3n, 4n],
      "collateral requirement is rounded UP (ceil): 3 wei principal at 100.01% needs 4 wei"
    );
    const quoted = await p.quoteCollateral(3n, 0n, 1n);
    t.wei(quoted[0], 4n, "quoteCollateral() reports the same ceil() requirement");
    t.wei(quoted[1], 3n, "quoteCollateral() reports totalDue == principal at 0 bps");

    const receipt = await ctx.send(p.connect(ctx.signer(1)).requestLoan(3n, 0n, 1n, { value: 4n }));
    t.event(receipt, p, "LoanRequested", [1n, a1, 3n, 0n, 0n, 1n, 4n], "LoanRequested carries the exact request parameters");
    t.wei((await p.getLoan(1n)).status, 2n, "the dusty 3 wei loan still activates because the pool has free liquidity");
    t.wei((await p.getLoan(1n)).collateral, 4n, "the dusty loan stores the exact 4 wei collateral");
  }

  // ---------------- status + bookkeeping ----------------
  {
    const { pool: p } = await bootstrap(ctx, { supply: SUPPLY });
    const { receipt, loan, loanId } = await requestLoan(ctx, p, 2, { principal: D, rateBps: 1000n, durationDays: 30n, collateral: D });
    t.wei(loanId, 1n, "the first loan gets id 1");
    t.wei(await p.loanCount(), 1n, "loanCount increments per request");
    t.eq(loan.borrower, ctx.addressOf(2), "the loan stores the borrower");
    t.wei(loan.rateBps, 1000n, "the loan freezes rateBps at request time");
    t.wei(loan.durationDays, 30n, "the loan freezes durationDays at request time");
    t.wei(loan.interest, simpleInterest(D, 1000n, 30n), "the loan freezes the exact simple interest");
    t.wei(loan.collateral, D, "the loan stores the posted collateral");
    t.gte(loan.startTime, 1n, "an instantly funded loan records startTime");
    t.wei(loan.dueDate - loan.startTime, 30n * 86400n, "dueDate == startTime + durationDays days");
    t.event(receipt, p, "LoanActivated", [1n, ctx.addressOf(2), loan.startTime, loan.dueDate], "instant activation emits LoanActivated");
    t.wei(await p.accumulatedCollateral(), D, "accumulatedCollateral tracks the locked collateral");
    t.includes(await p.getUserLoans(ctx.addressOf(2)), 1n, "getUserLoans() records the new loan id");

    // A request larger than free liquidity stays Pending.
    const pending = await requestLoan(ctx, p, 3, { principal: 20n * D, rateBps: 1000n, durationDays: 30n, collateral: 20n * D });
    t.wei(pending.loan.status, 1n, "a request exceeding free liquidity becomes Pending");
    t.wei(pending.loan.amountFunded, 0n, "a pending request has nothing funded");
    t.wei(pending.loan.startTime, 0n, "a pending request has no startTime");
    t.wei(pending.loan.dueDate, 0n, "a pending request has no dueDate");
    t.wei(await p.loanCount(), 2n, "the pending request still consumed a loan id");
  }

  // ---------------- pause gate ----------------
  {
    const { pool: p } = await bootstrap(ctx, { supply: SUPPLY });
    await ctx.send(p.setPaused(true));
    await t.reverts(
      () => p.connect(ctx.signer(1)).requestLoan.staticCall(D, 1000n, 30n, { value: D }),
      "PoolPaused",
      [],
      "requestLoan() while paused reverts PoolPaused"
    );
  }
}

module.exports = { name: "04 requestLoan validation matrix", run };
