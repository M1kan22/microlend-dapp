"use strict";
/**
 * Suite 06 — repayLoan: exact simple interest, fee split, overpayment refund, double-repay guard,
 * and late fees after time travel. Spec rule 7 and section 1.
 */
const { H, D, BPS, SUPPLY, bootstrap, requestLoan, dueOf, simpleInterest, advancePastDue } = require("./_helpers");

const PRINCIPAL = D;
const RATE = 1000n;
const DAYS = 30n;
const INTEREST = simpleInterest(PRINCIPAL, RATE, DAYS); // 8_219_178_082_191_780
const FEE = (INTEREST * 1000n) / BPS;                   // 821_917_808_219_178
const NET_INTEREST = INTEREST - FEE;                    // 7_397_260_273_971_602

async function run(ctx, t) {
  const a0 = ctx.addressOf(0);
  const a1 = ctx.addressOf(1);
  const a2 = ctx.addressOf(2);

  // ---------------- exact interest math (spec section 1 formula) ----------------
  t.wei(INTEREST, 8_219_178_082_191_780n, "harness: 1 ETH at 1000 bps for 30 days is exactly 8219178082191780 wei");
  {
    const { pool: probe } = await bootstrap(ctx, { deposit: false });
    t.wei(
      await probe.previewInterest(PRINCIPAL, RATE, DAYS),
      INTEREST,
      "previewInterest(1 ETH, 1000 bps, 30 d) == principal * rateBps * days / (10000 * 365)"
    );
    t.wei(await probe.previewInterest(PRINCIPAL, 0n, DAYS), 0n, "previewInterest at 0 bps is 0");
    t.wei(await probe.previewInterest(PRINCIPAL, 5000n, 365n), PRINCIPAL / 2n, "previewInterest at 50% APR for 365 days is exactly half the principal");
  }

  // ---------------- on-time repayment ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    const { loan } = await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    t.wei(loan.interest, INTEREST, "the loan stores the exact frozen interest");

    const { amountDue, lateFee } = await dueOf(pool, 1n);
    t.wei(amountDue, PRINCIPAL + INTEREST, "amountDue == principal + interest before the due date");
    t.wei(lateFee, 0n, "no late fee before the due date");

    await t.reverts(
      () => pool.connect(ctx.signer(1)).repayLoan.staticCall(1n, { value: amountDue - 1n }),
      "InsufficientPayment",
      [amountDue - 1n, amountDue],
      "repayLoan one wei short reverts InsufficientPayment(provided, required)"
    );

    // paid by a third party: repayLoan has no borrower restriction
    const payerBefore = await ctx.balance(a2);
    const borrowerBefore = await ctx.balance(a1);
    const receipt = await ctx.send(pool.connect(ctx.signer(2)).repayLoan(1n, { value: amountDue }));
    const payerGas = receipt.gasUsed * receipt.gasPrice;
    t.wei((await ctx.balance(a2)) - payerBefore, -amountDue - payerGas, "the payer funds the whole repayment (net of gas)");
    t.wei((await ctx.balance(a1)) - borrowerBefore, PRINCIPAL, "the borrower gets the collateral back");
    t.event(receipt, pool, "LoanRepaid", [1n, a2, PRINCIPAL, INTEREST, 0n, FEE, amountDue], "LoanRepaid(loanId, payer, principal, interest, lateFee, fee, totalPaid)");

    const loanAfter = await pool.getLoan(1n);
    t.wei(loanAfter.status, 3n, "the loan is marked Repaid");
    t.wei(loanAfter.collateral, 0n, "the loan's collateral is zeroed");
    t.wei(await pool.accumulatedCollateral(), 0n, "accumulatedCollateral drops back to zero");
    t.wei(await pool.reservedLiquidity(), 0n, "reservedLiquidity is released");
    t.wei(await pool.activeLoanCountOf(a1), 0n, "activeLoanCountOf[borrower] drops to zero");
    t.wei(await pool.totalInterestEarned(), INTEREST, "totalInterestEarned == the gross interest charged");
    t.wei(await pool.totalFeesCollected(), FEE, "totalFeesCollected == interest * feeBps / 10000");
    t.wei(await pool.treasuryBalance(), FEE, "treasuryBalance == the protocol fee");
    t.wei(await pool.totalLiquidity(), SUPPLY + NET_INTEREST, "totalLiquidity grows by exactly the net interest (fee excluded)");

    await t.reverts(() => pool.repayLoan.staticCall(1n, { value: amountDue }), "LoanNotActive", [1n], "a second repayment reverts LoanNotActive(id)");
  }

  // ---------------- overpayment refund ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    const { amountDue } = await dueOf(pool, 1n);
    const overpay = 3n * D;
    const payerBefore = await ctx.balance(a2);
    const receipt = await ctx.send(pool.connect(ctx.signer(2)).repayLoan(1n, { value: amountDue + overpay }));
    const gas = receipt.gasUsed * receipt.gasPrice;
    t.wei((await ctx.balance(a2)) - payerBefore, -amountDue - gas, "the overpayment is fully refunded to the payer (net of gas)");
    t.event(receipt, pool, "LoanRepaid", [1n, a2, PRINCIPAL, INTEREST, 0n, FEE, amountDue], "the recorded totalPaid excludes the refunded overpayment");
    t.wei(await pool.totalLiquidity(), SUPPLY + NET_INTEREST, "the refund does not inflate totalLiquidity");
  }

  // ---------------- non-active loans ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await t.reverts(() => pool.repayLoan.staticCall(99n, { value: D }), "InvalidLoan", [99n], "repayLoan on an unknown id reverts InvalidLoan(id)");
    await requestLoan(ctx, pool, 1, { principal: 20n * D, collateral: 20n * D }); // Pending
    await t.reverts(() => pool.repayLoan.staticCall(1n, { value: D }), "LoanNotActive", [1n], "repaying a Pending loan reverts LoanNotActive(id)");
    await t.reverts(
      () => pool.previewRepayment.staticCall(1n),
      "LoanNotActive",
      [1n],
      "previewRepayment on a Pending loan reverts LoanNotActive(id)"
    );
  }

  // ---------------- rule 7: late fee, one started 30-day period ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    const now = await advancePastDue(ctx, pool, 1n, 900n); // 15 minutes into the first late period
    const loan = await pool.getLoan(1n);
    const lateSeconds = now - BigInt(loan.dueDate);
    const periods = lateSeconds / (30n * 86400n) + 1n;
    const base = PRINCIPAL + INTEREST;
    const expectedLateFee = (base * 100n * periods) / BPS;
    const expectedDue = base + expectedLateFee;

    t.wei(periods, 1n, "15 minutes overdue is exactly 1 started late period");
    const { amountDue, lateFee } = await dueOf(pool, 1n);
    t.wei(lateFee, expectedLateFee, "lateFee == baseDue * lateFeeBps * periods / 10000 (exact)");
    t.wei(amountDue, expectedDue, "amountDue == baseDue + lateFee (exact)");
    t.gt(amountDue, PRINCIPAL + INTEREST, "a late repayment costs strictly more than an on-time one");

    const receipt = await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: amountDue }));
    t.event(receipt, pool, "LoanRepaid", [1n, a1, PRINCIPAL, INTEREST, expectedLateFee, FEE, amountDue], "LoanRepaid reports the late fee in wei");
    t.wei(await pool.totalInterestEarned(), INTEREST + expectedLateFee, "totalInterestEarned includes the late fee");
    t.wei(await pool.treasuryBalance(), FEE, "the protocol fee is still computed on plain interest only");
    t.wei(
      await pool.totalLiquidity(),
      SUPPLY + NET_INTEREST + expectedLateFee,
      "the whole late fee is credited to the suppliers' totalLiquidity claim"
    );
  }

  // ---------------- late fee: two started periods ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    const now = await advancePastDue(ctx, pool, 1n, 30n * 86400n + 900n); // into the second late period
    const loan = await pool.getLoan(1n);
    const lateSeconds = now - BigInt(loan.dueDate);
    const periods = lateSeconds / (30n * 86400n) + 1n;
    const base = PRINCIPAL + INTEREST;
    const expectedLateFee = (base * 100n * periods) / BPS;
    t.wei(periods, 2n, "30 days + 15 minutes overdue is exactly 2 started late periods");
    t.wei((await dueOf(pool, 1n)).lateFee, expectedLateFee, "the late fee doubles for the second started period (exact)");
    t.wei((await dueOf(pool, 1n)).amountDue, base + expectedLateFee, "amountDue follows the periods formula exactly");
  }

  // ---------------- interest is frozen at request time ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    const before = await dueOf(pool, 1n);
    await ctx.send(pool.setParams(10n ** 12n, 10n ** 13n, 100n * D, 365n, 5_000n, 10_000n, 2_000n, 500n, 100n));
    const after = await dueOf(pool, 1n);
    t.wei(after.amountDue, before.amountDue, "changing feeBps after the request does not change this loan's amount due");
    t.wei((await pool.getLoan(1n)).interest, INTEREST, "the stored interest stays frozen");
  }

  // ---------------- repayment is allowed while paused (risk-reducing action) ----------------
  {
    const { pool } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, pool, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    const { amountDue } = await dueOf(pool, 1n);
    await ctx.send(pool.setPaused(true));
    const receipt = await ctx.send(pool.connect(ctx.signer(1)).repayLoan(1n, { value: amountDue }));
    t.eq(await pool.paused(), true, "the pool is still paused after the repayment");
    t.wei((await pool.getLoan(1n)).status, 3n, "repayLoan succeeds while paused (no whenLive gate)");
    t.event(receipt, pool, "LoanRepaid", [1n, a1, PRINCIPAL, INTEREST, 0n, FEE, amountDue], "the paused repayment emits the exact figures");
  }

  // ---------------- late fees make late repayment strictly better for suppliers ----------------
  {
    const { pool: onTime } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, onTime, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    await ctx.send(onTime.connect(ctx.signer(1)).repayLoan(1n, { value: (await dueOf(onTime, 1n)).amountDue }));

    const { pool: late } = await bootstrap(ctx, { supply: SUPPLY });
    await requestLoan(ctx, late, 1, { principal: PRINCIPAL, rateBps: RATE, durationDays: DAYS, collateral: PRINCIPAL });
    await advancePastDue(ctx, late, 1n, 900n);
    const lateDue = await dueOf(late, 1n);
    await ctx.send(late.connect(ctx.signer(1)).repayLoan(1n, { value: lateDue.amountDue }));

    t.gt(await late.totalLiquidity(), await onTime.totalLiquidity(), "a late repayment leaves suppliers with more than an on-time one");
    t.eq(await late.totalFeesCollected(), await onTime.totalFeesCollected(), "the protocol fee is identical in both cases");
    t.check((await ctx.balance(late.target)) === (await late.totalLiquidity()) + (await late.treasuryBalance()),
      "money invariant after the late repayment (no reserved liquidity)");
    t.check((await ctx.balance(onTime.target)) === (await onTime.totalLiquidity()) + (await onTime.treasuryBalance()),
      "money invariant after the on-time repayment");
    t.wei(await late.totalBadDebt(), 0n, "no bad debt was recorded");
    t.wei((await late.totalInterestEarned()) - (await onTime.totalInterestEarned()), lateDue.lateFee,
      "the extra interest earned vs an on-time repayment is exactly the late fee");
    t.gt(lateDue.lateFee, 0n, "the late fee captured for the comparison is non-zero");
  }
}

module.exports = { name: "06 repayLoan (exact interest, fee split, late fees)", run };
