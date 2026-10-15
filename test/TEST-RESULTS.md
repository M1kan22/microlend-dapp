# MicroLend — contract test results

Generated: 2026-10-15T08:04:22.499Z  
Command: `node test/run-tests.js`  
Toolchain: solc 0.8.24 (optimizer runs 200, shanghai), ganache 7.9.2, ethers 6.17.0, Node v24.21.0

## Summary

| # | Suite | Assertions | Passed | Failed | Money-invariant checks | Time |
|---:|---|---:|---:|---:|---:|---:|
| 1 | 01 deployment + frozen interface | 142 | 142 | 0 | 0 | 1.57s |
| 2 | 02 deposits + share math + donation safety | 39 | 39 | 0 | 0 | 4.45s |
| 3 | 03 withdraw (paused exit, share burn, reserved lock) | 40 | 40 | 0 | 0 | 5.33s |
| 4 | 04 requestLoan validation matrix | 39 | 39 | 0 | 0 | 5.46s |
| 5 | 05 activation vs pending + fundLoan | 51 | 51 | 0 | 0 | 9.25s |
| 6 | 06 repayLoan (exact interest, fee split, late fees) | 50 | 50 | 0 | 0 | 13.72s |
| 7 | 07 liquidate (both branches + supplier-exit regressions) | 69 | 69 | 0 | 0 | 9.31s |
| 8 | 08 cancelLoan (borrower-only, pending-only, refund) | 27 | 27 | 0 | 0 | 8.28s |
| 9 | 09 governance + access control | 62 | 62 | 0 | 0 | 9.20s |
| 10 | 10 pause behaviour matrix | 25 | 25 | 0 | 0 | 11.70s |
| 11 | 11 read helpers (poolStats, positions, previews) | 84 | 84 | 0 | 0 | 6.12s |
| 12 | 12 reentrancy guard (live attacker contract) | 76 | 76 | 0 | 0 | 22.18s |
| 13 | 13 money invariant (rule 12) after every scenario | 107 | 107 | 0 | 14 | 26.97s |
| | **TOTAL** | **811** | **811** | **0** | **14** | **134.92s** |

**811/811 assertions passed** across 13 suites in 134.92s; 14 of those are money-invariant checks.

## Money invariant

```
address(pool).balance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance
```

free liquidity + collateral held + unclaimed fees are the only ETH the contract may hold. reservedLiquidity is already inside totalLiquidity but has been disbursed to borrowers, so it is excluded. The spec's original rule-12 wording (since amended in docs/INTEGRATION_SPEC.md to the identity above) read totalLiquidity + accumulatedCollateral + treasuryBalance + DEAD_SHARES, which omits -reservedLiquidity and adds 1 wei the bootstrap deposit does not create; suite 13 measures both deviations exactly, in wei, so the amendment is reproducible rather than asserted on trust.

## Failing assertions

None — every assertion passed.

## Suite coverage

| Suite | Spec coverage |
|---|---|
| 01 deployment + frozen interface | §2.1-2.6: every mutating signature, read helper, event and custom error; constants; defaults; one-shot `initialize`; `NotInitialized`/`NotOwner` gates |
| 02 deposits + share math + donation safety | rules 1 and 2: `minDeposit`, DEAD_SHARES bootstrap, pro-rata minting, `receive`/`fallback` rejection, inflation-attack resistance |
| 03 withdraw | rule 3: `ZeroAmount`, `InsufficientShares`, exit while paused, reserved-liquidity lock, exact share appreciation |
| 04 requestLoan validation matrix | rule 4: principal/duration/rate bounds, `ceil()` collateral, inclusive boundaries |
| 05 activation vs pending + fundLoan | rules 5 and 6: instant activation, pending path, partial/complete funding, share minting, `LoanNotPending`/`AmountTooLarge`/`AmountTooSmall` |
| 06 repayLoan | rule 7: exact simple interest, fee split, overpayment refund, double-repay, late-fee periods after time travel |
| 07 liquidate | rule 8: overdue gate (including exactly at `dueDate`), excess-collateral refund, bad-debt write-off, sole-supplier exit regressions |
| 08 cancelLoan | rule 9: borrower-only, pending-only, `NotFunded`, refund accounting |
| 09 governance + access control | rule 11: `NotOwner` on every owner-only entry point, full `setParams` matrix, treasury claim and its free-liquidity cap, initialisation front-running (documented limitation) |
| 10 pause behaviour matrix | pause blocks `deposit`/`requestLoan`/`fundLoan`; exit paths (`withdraw`, `repayLoan`, `cancelLoan`, `liquidate`, `claimTreasury`) stay open |
| 11 read helpers | §2.4: `poolStats`, `liabilities`, `getUserPosition`, `getUserLoans`, previews, `collateralRatio`, `isOverdue`, `quoteCollateral` |
| 12 reentrancy guard | rule 10: a live attacker contract re-enters each of the 8 guarded functions from every ETH callback and observes `Reentrancy()` |
| 13 money invariant | rule 12 after 14 distinct scenarios plus the exact deviation of the pre-amendment formula text |

## Regression history (audit trail)

**Settlement double-count (found by this suite, fixed by the contract owner).** Against sourceHash
`0x…` (pre-fix revision) the canonical identity broke on every settlement:

- `_settleRepayment` credited `principal + netInterest` to `totalLiquidity` even though `totalLiquidity` already contained the outstanding principal while the loan was reserved, so supplier claims exceeded the pool balance by exactly `principal` (repro: deposit 10 ETH → 1 ETH loan at 1000 bps/30 d → repay 18219178082191780 wei → `totalLiquidity` 10000000000000000000 → 11007397260273972602, `totalLiquidity + treasuryBalance − balance == 1e18`).
- User-visible symptom: `withdraw(sharesOf[supplier])` passed the `availableLiquidity` check (11007397260273972600 ≤ 11007397260273972602) but the contract only held 10008219178082191780 wei, so the transfer failed and reverted `TransferFailed` — the last suppliers could not exit.
- `liquidate` credited the whole seizure on top of the same claim (`totalLiquidity += compensation`), over-crediting suppliers by `principal` in both the excess-collateral and bad-debt branches.
- The late fee was received but never credited to any liability, stranding `lateFee` wei in the contract.

Fix: `totalLiquidity += netInterest + lateFee` on repayment, `totalLiquidity = totalLiquidity - principal + compensation` on liquidation, and `claimTreasury` no longer deducts from `totalLiquidity`.
Regression guards: suite 03 (sole supplier full exit after repayment), suite 07 (full exit after both
liquidation branches, supplier absorbs the bad-debt loss), suite 06 (late fee credited to suppliers),
suite 13 (identity asserted in 14 states, all deltas 0 wei).

**Rule 12 text amended.** The original wording `balance == totalLiquidity + accumulatedCollateral + treasuryBalance + DEAD_SHARES` is unsatisfiable: it overshoots by exactly `DEAD_SHARES` straight after the bootstrap deposit and omits `- reservedLiquidity` (overshoot `principal + DEAD_SHARES` after any activation). Suite 13 measures both deviations exactly instead of asserting the wrong formula.

## Known limitations (asserted, not hidden)

- `initialize()` is first-caller-wins: anyone can front-run the deployment transaction and become owner/treasury. Suite 09 asserts this behaviour and `scripts/deploy.js` performs `initialize` inside the deployment run to shrink the window.
- ganache strips custom-error data from `eth_call` payloads that carry a non-zero value, so `receive()`/`fallback()` rejection is asserted through a zero-value call for the error selector plus a real mined value transfer whose receipt status is 0.

## Per-assertion evidence (machine readable)

The full list of assertions with suite, kind and pass/fail is in `test/test-results.json` (`records`).

| Suite | Assertions | Failed | Invariant checks | Invariant failures |
|---|---:|---:|---:|---:|
| 01 deployment + frozen interface | 142 | 0 | 0 | 0 |
| 02 deposits + share math + donation safety | 39 | 0 | 0 | 0 |
| 03 withdraw (paused exit, share burn, reserved lock) | 40 | 0 | 0 | 0 |
| 04 requestLoan validation matrix | 39 | 0 | 0 | 0 |
| 05 activation vs pending + fundLoan | 51 | 0 | 0 | 0 |
| 06 repayLoan (exact interest, fee split, late fees) | 50 | 0 | 0 | 0 |
| 07 liquidate (both branches + supplier-exit regressions) | 69 | 0 | 0 | 0 |
| 08 cancelLoan (borrower-only, pending-only, refund) | 27 | 0 | 0 | 0 |
| 09 governance + access control | 62 | 0 | 0 | 0 |
| 10 pause behaviour matrix | 25 | 0 | 0 | 0 |
| 11 read helpers (poolStats, positions, previews) | 84 | 0 | 0 | 0 |
| 12 reentrancy guard (live attacker contract) | 76 | 0 | 0 | 0 |
| 13 money invariant (rule 12) after every scenario | 107 | 0 | 14 | 0 |

