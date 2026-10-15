"use strict";
/**
 * test/suites/_helpers.js — small shared helpers for the suite files.
 */
const path = require("path");
const H = require("../harness");

const D = 10n ** 18n;          // 1 ETH in wei
const BPS = 10000n;
const DAY = 86400n;
const DEFAULT_RATE_BPS = 1000n;
const DEFAULT_DURATION_DAYS = 30n;
const SUPPLY = 10n * D;

/** interest = principal * rateBps * durationDays / (10000 * 365) — spec section 1. */
function simpleInterest(principal, rateBps, durationDays) {
  return (principal * rateBps * durationDays) / (10000n * 365n);
}

/** Advanced to exactly one second after the loan's due date (strictly overdue). */
async function advancePastDue(ctx, pool, loanId, offset = 1n) {
  const loan = await pool.getLoan(loanId);
  if (BigInt(loan.dueDate) === 0n) throw new Error(`loan ${loanId} has no dueDate yet`);
  return ctx.advanceTo(BigInt(loan.dueDate) + offset);
}

/** Assert an exact canonical signature exists in the ABI (function / event / error). */
function assertSignature(t, iface, kind, signature, name) {
  let got = null;
  let ok = false;
  try {
    const frag =
      kind === "function" ? iface.getFunction(signature) : kind === "event" ? iface.getEvent(signature) : iface.getError(signature);
    got = frag ? frag.format("sighash") : null;
    ok = !!got && got === signature;
  } catch (err) {
    got = H.oneLine(err);
  }
  return t.check(ok, name, `expected ${kind} ${signature} in the ABI — compiler output has ${got}`);
}

/**
 * Deploy a pool and (optionally) seed supplier liquidity.
 * @returns {Promise<{pool: object, receipt: object|null}>}
 */
async function bootstrap(ctx, options = {}) {
  const { supply = SUPPLY, initialize = true, deposit = true, depositor = 0 } = options;
  const pool = await ctx.deploy({ initialize });
  let receipt = null;
  if (initialize && deposit && supply > 0n) {
    receipt = await ctx.send(pool.connect(ctx.signer(depositor)).deposit({ value: supply }));
  }
  return { pool, receipt };
}

/** Open a loan from account `idx`; returns the receipt, loan id and stored loan struct. */
async function requestLoan(ctx, pool, idx, options = {}) {
  const {
    principal = D,
    rateBps = DEFAULT_RATE_BPS,
    durationDays = DEFAULT_DURATION_DAYS,
    collateral = principal,
  } = options;
  const connected = pool.connect(ctx.signer(idx));
  const receipt = await ctx.send(connected.requestLoan(principal, rateBps, durationDays, { value: collateral }));
  const loanId = await pool.loanCount();
  return { receipt, loanId, loan: await pool.getLoan(loanId) };
}

/** Current amount due for an active loan plus its late-fee component. */
async function dueOf(pool, loanId) {
  const [amountDue, lateFee] = await pool.previewRepayment(loanId);
  return { amountDue: BigInt(amountDue), lateFee: BigInt(lateFee) };
}

/** Send a transfer that carries no data (hits receive()). */
async function rawTransfer(ctx, fromIdx, to, value) {
  const signer = ctx.signer(fromIdx);
  const tx = await signer.sendTransaction({ to, value });
  return tx.wait();
}

module.exports = {
  H,
  path,
  D,
  BPS,
  DAY,
  SUPPLY,
  DEFAULT_RATE_BPS,
  DEFAULT_DURATION_DAYS,
  simpleInterest,
  advancePastDue,
  assertSignature,
  bootstrap,
  requestLoan,
  dueOf,
  rawTransfer,
};
