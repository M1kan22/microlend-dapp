"use strict";
/**
 * Suite 05 — Loan activation vs pending, and fundLoan.
 * Spec rules 5 and 6.
 */
const { H, D, SUPPLY, bootstrap, requestLoan, simpleInterest } = require("./_helpers");

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);
  const a2 = ctx.addressOf(2);

  // ---------------- rule 5a: instant activation when free liquidity is sufficient ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const borrowerBefore = await ctx.balance(a1);
    const principal = D;
    const interest = simpleInterest(principal, 1000n, 30n);
    const { receipt, loan } = await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    const borrowerAfter = await ctx.balance(a1);
    const gas = receipt.gasUsed * receipt.gasPrice;

    t.wei(loan.status, 2n, "with enough free liquidity the loan activates immediately (status Active)");
    t.wei(loan.amountFunded, principal, "an instantly active loan is marked fully funded");
    t.wei(loan.interest, interest, "activation re-derives the frozen interest from the stored rate/duration");
    t.wei(borrowerAfter - borrowerBefore, -gas, "the borrower pays collateral and gets the principal back, so the net cost is gas only");
    t.event(receipt, pool, "LoanActivated", [1n, a1, loan.startTime, loan.dueDate], "LoanActivated(loanId, borrower, startTime, dueDate) is emitted");
    t.wei(loan.dueDate, BigInt(loan.startTime) + 30n * 86400n, "dueDate == startTime + durationDays * 1 days");

    const stats = await pool.poolStats();
    t.wei(stats[3], principal, "reservedLiquidity == the disbursed principal");
    t.wei(stats[2], SUPPLY - principal, "availableLiquidity == totalLiquidity - reservedLiquidity");
    t.wei(await pool.accumulatedCollateral(), principal, "the borrower's collateral is held in accumulatedCollateral");
    t.wei(await pool.activeLoanCountOf(a1), 1n, "activeLoanCountOf[borrower] == 1");
    t.wei(await pool.pendingLoanCountOf(a1), 0n, "pendingLoanCountOf[borrower] == 0 after activation");
    t.wei(await ctx.balance(pool.target), SUPPLY, "the pool holds its own deposit + collateral - disbursed principal");
  }

  // ---------------- rule 5b: pending when liquidity is short ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const borrowerBefore = await ctx.balance(a1);
    const principal = 20n * D;
    const receipt = await ctx.send(
      pool.connect(ctx.signer(1)).requestLoan(principal, 1000n, 30n, { value: principal })
    );
    const loan = await pool.getLoan(1n);
    const gas = receipt.gasUsed * receipt.gasPrice;

    t.wei(loan.status, 1n, "a request above free liquidity stays Pending");
    t.wei(loan.amountFunded, 0n, "a pending loan has no funding yet");
    t.wei(loan.startTime, 0n, "a pending loan has startTime == 0");
    t.wei(loan.dueDate, 0n, "a pending loan has dueDate == 0");
    t.wei((await ctx.balance(a1)) - borrowerBefore, -principal - gas, "the pending borrower only paid collateral (+gas) and received nothing");    t.wei(await pool.pendingLoanCountOf(a1), 1n, "pendingLoanCountOf[borrower] == 1");
    t.wei(await pool.activeLoanCountOf(a1), 0n, "activeLoanCountOf[borrower] == 0 while pending");
    t.wei(await pool.reservedLiquidity(), 0n, "a pending loan reserves no liquidity");
    t.wei(await pool.accumulatedCollateral(), principal, "the pending collateral is still pooled");
    t.noEvent(receipt, pool, "LoanActivated", "no LoanActivated event is emitted for a pending request");
  }

  // ---------------- rule 6: fundLoan mints shares, then activates ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const principal = 20n * D;
    await requestLoan(ctx, pool, 1, { principal, collateral: principal });
    const sharesBefore = await pool.totalShares();

    // partial funding
    const partial = 5n * D;
    const partialShares = (partial * sharesBefore) / (await pool.totalLiquidity());
    const partialReceipt = await ctx.send(pool.connect(ctx.signer(2)).fundLoan(1n, { value: partial }));
    t.wei(await pool.sharesOf(a2), partialShares, "fundLoan mints floor(amount * totalShares / totalLiquidity) shares for the funder");
    t.event(partialReceipt, pool, "LiquidityDeposited", [a2, partial, partialShares], "fundLoan emits LiquidityDeposited like a normal deposit");
    t.event(partialReceipt, pool, "LoanFunded", [1n, a2, partial, partial], "LoanFunded(loanId, funder, amount, totalFunded)");
    t.wei((await pool.getLoan(1n)).amountFunded, partial, "amountFunded tracks the partial contribution");
    t.wei((await pool.getLoan(1n)).status, 1n, "the loan is still Pending until fully funded");
    t.wei(await pool.totalDeposited(), SUPPLY + partial, "fundLoan counts towards totalDeposited");
    t.wei(await pool.reservedLiquidity(), 0n, "partial funding still reserves no liquidity");

    // completion by a third funder
    const rest = principal - partial;
    const restShares = (rest * (await pool.totalShares())) / (await pool.totalLiquidity());
    const borrowerBefore = await ctx.balance(a1);
    const done = await ctx.send(pool.connect(ctx.signer(3)).fundLoan(1n, { value: rest }));
    const borrowerAfter = await ctx.balance(a1);
    const loan = await pool.getLoan(1n);
    t.wei(loan.amountFunded, principal, "the loan is fully funded once amountFunded == principal");
    t.wei(loan.status, 2n, "full funding activates the loan");
    t.wei(await pool.sharesOf(ctx.addressOf(3)), restShares, "the completing funder receives the pro-rata shares too");
    t.event(done, pool, "LoanActivated", [1n, a1, loan.startTime, loan.dueDate], "completion emits LoanActivated");
    t.wei(borrowerAfter - borrowerBefore, principal, "the borrower is paid out the full principal on completion (the funder pays the gas)");
    t.wei(await pool.reservedLiquidity(), principal, "activation reserves the principal");
    t.wei(await pool.activeLoanCountOf(a1), 1n, "the borrower now has one active loan");
    t.wei(await pool.pendingLoanCountOf(a1), 0n, "their pending counter is cleared");
    const stats = await pool.poolStats();
    t.wei(stats[2], SUPPLY + principal - principal, "availableLiquidity after activation == totalLiquidity - principal");
  }

  // ---------------- fundLoan validation ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.fundLoan.staticCall(99n, { value: D }), "InvalidLoan", [99n], "fundLoan on an unknown id reverts InvalidLoan(id)");
    await t.reverts(() => pool.fundLoan.staticCall(1n, { value: D }), "InvalidLoan", [1n], "fundLoan(1) with an empty book reverts InvalidLoan(1)");

    // active loan -> LoanNotPending
    await requestLoan(ctx, pool, 1, { principal: D, collateral: D });
    await t.reverts(() => pool.fundLoan.staticCall(1n, { value: D }), "LoanNotPending", [1n], "fundLoan on an Active loan reverts LoanNotPending(id)");

    // pending loan -> zero value / over-funding / below-one-share
    const principal = 20n * D;
    await requestLoan(ctx, pool, 2, { principal, collateral: principal });
    await t.reverts(() => pool.fundLoan.staticCall(2n, { value: 0n }), "ZeroAmount", [], "fundLoan with no ETH reverts ZeroAmount");
    await t.reverts(
      () => pool.fundLoan.staticCall(2n, { value: principal + 1n }),
      "AmountTooLarge",
      [principal + 1n, principal],
      "fundLoan above the remaining principal reverts AmountTooLarge(value, remaining)"
    );
    await ctx.send(pool.connect(ctx.signer(4)).fundLoan(2n, { value: principal / 2n }));
    await t.reverts(
      () => pool.fundLoan.staticCall(2n, { value: principal / 2n + 1n }),
      "AmountTooLarge",
      [principal / 2n + 1n, principal / 2n],
      "the remaining check uses amountFunded, not just principal"
    );
  }

  // ---------------- fundLoan contribution too small to mint a share ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 9n * D, collateral: 9n * D });
    await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: await pool.previewRepayment(1n).then((r) => r[0]) }));
    // interest has lifted totalLiquidity above totalShares, so 1 wei buys less than one share
    t.gt(await pool.totalLiquidity(), await pool.totalShares(), "after a repayment totalLiquidity > totalShares (share price above 1)");
    await requestLoan(ctx, pool, 2, { principal: 20n * D, collateral: 20n * D });
    await t.reverts(
      () => pool.fundLoan.staticCall(2n, { value: 1n }),
      "AmountTooSmall",
      [1n, 10n ** 12n],
      "fundLoan of 1 wei when a wei buys < 1 share reverts AmountTooSmall(value, minDeposit)"
    );
    const funded = await ctx.send(pool.connect(ctx.signer(4)).fundLoan(2n, { value: 10n ** 6n }));
    t.gt(await pool.sharesOf(ctx.addressOf(4)), 0n, "a larger contribution mints at least one share");
    t.event(funded, pool, "LoanFunded", [2n, ctx.addressOf(4), 10n ** 6n, 10n ** 6n], "the successful contribution emits LoanFunded");
  }

  // ---------------- pause gate ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: 20n * D, collateral: 20n * D });
    await ctx.send(pool.setPaused(true));
    await t.reverts(() => pool.fundLoan.staticCall(1n, { value: 5n * D }), "PoolPaused", [], "fundLoan() while paused reverts PoolPaused");
    t.wei(await pool.loanCount(), 1n, "loanCount still reflects the paused-out request");
    t.check((await pool.sharesOf(a0)) > 0n, "the supplier keeps their shares while the pool is paused");
  }
}

module.exports = { name: "05 activation vs pending + fundLoan", run };
