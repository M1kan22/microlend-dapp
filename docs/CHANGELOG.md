# Changelog — MicroLend DApp

**Student:** ZHANG SHUJIA · **Student ID:** G2601577A · SC6113 Individual Assignment

All notable changes to this project. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.0.0] — unreleased (SC6113 submission)

### Added
- `contracts/MicroLendPool.sol` — peer-to-pool micro-lending protocol: supplier deposits and
  appreciating shares, collateralised micro-loans with instant-activation or pending funding,
  simple-interest repayment with a protocol fee, late fees, and permissionless liquidation with an
  explicit bad-debt path. 61 ABI functions, 14 events, 25 custom errors.
- Flask backend with SQLite indexer, MetaMask signature authentication, per-field validation and a
  documented JSON envelope (`backend/`).
- Vanilla HTML/CSS/JS frontend with MetaMask wallet integration, a live protocol dashboard, loan
  management, transaction history, and an explicitly-badged offline demo mode (`frontend/`).
- Real-EVM test suite executed against an in-process chain (`test/`), plus local-chain and Sepolia
  deployment scripts (`scripts/`).
- Documentation: `README.md`, `docs/REPORT.md`, `docs/TESTING.md`, `docs/SCREENSHOTS.md`,
  `docs/INTEGRATION_SPEC.md`.

### Fixed — settlement accounting (found by independent review before submission)
Four defects in the first draft of `MicroLendPool.sol` were found by two independent reviewers
(`contract-chain` running real transactions on an in-process EVM, and `docs-qa` reproducing them
separately) and fixed by the author. They are recorded here because the review process is part of
the assignment's Testing and Evaluation criterion.

1. **Principal double-credited on repayment.** `_settleRepayment` did
   `totalLiquidity += principal + netInterest`. The lent principal was already a supplier claim
   tracked through `reservedLiquidity`, so the pool overstated supplier entitlements by exactly the
   principal. User-visible symptom: the *only* supplier could not withdraw their full balance —
   `withdraw(sharesOf)` passed the availability check but the contract no longer held the ETH, so
   the transfer reverted with `TransferFailed`.
   *Fix:* credit only the income the pool earned — `totalLiquidity += netInterest + lateFee`.
2. **Liquidation credited the seizure on top of the principal claim.** `liquidate` did
   `totalLiquidity += compensation`, so on both the excess-collateral and the bad-debt branch the
   suppliers were credited the full principal *and* the seizure, overstating claims by the principal.
   *Fix:* `totalLiquidity = totalLiquidity - loan.principal + compensation`, which makes suppliers
   the residual claimant and lets them actually bear a default shortfall.
3. **Late fees had no claimant.** `_previewRepayment` charged a late fee but `_settleRepayment`
   never credited it to any liability, leaving the ETH permanently stranded in the contract.
   *Fix:* the late fee is credited to `totalLiquidity` and included in `totalInterestEarned`.
4. **`claimTreasury` debited `totalLiquidity`.** Fees accrue to the separate `treasuryBalance`
   claim and were never part of `totalLiquidity`, so the extra debit made suppliers pay the fee
   twice. *Fix:* only `treasuryBalance` decreases; the supplier claim is untouched.

The corrected identity, asserted after every scenario in the test suite, is:

```
address(pool).balance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance
```

### Changed
- `liquidate` clamps the reservation release (`min(loan.principal, reservedLiquidity)`) so
  `availableLiquidity` can never underflow and wrap to a huge number.
- `setParams` now enforces `MIN_COLLATERAL_FLOOR_BPS = 5_000` (50% of principal) as the lower bound
  for the collateral requirement, which is what makes the bad-debt branch reachable; the default
  remains 10_000 (100%).
- `docs/INTEGRATION_SPEC.md` §1 and §2.7(12) amended to state the exact settlement and fee-routing
  rules and the corrected money invariant.

## [1.2.0]

### Added
- `scripts/capture-ui.ps1` — headless screenshots of the real client at any viewport width.
- `scripts/measure-ui.js` — DevTools-protocol layout measurement (document height, per-column
  table widths, overflow detection, first-viewport composition).
- `docs/make_report.py` gained `--pdf` and markdown-image support, so `docs/REPORT.md` exports to a
  paginated `docs/MicroLend-Report.docx` and `docs/MicroLend-Report.pdf` with the dashboard figure
  embedded.
- Student identity recorded across the report, README and this changelog.

### Changed
- Report condensed from 16 pages to the assignment's 8-page limit by moving verbatim evidence to
  `docs/TESTING.md` and tightening the document template — it previously spent a full page on a
  near-empty title page.
- Client restyled as a working dashboard: the editorial headline dropped from 108 px to 29 px, the
  rhythm scale from 104 px to 36 px, and long tables now scroll inside their panel instead of
  stretching the page.

### Fixed — table layout, found by measuring the rendered page
- The loan book's Status column rendered **34.6 px** wide, so status pills stacked one letter per
  line, and the Loan column rendered **27.1 px**, wrapping its header to "L o a n". CSS `width` on a
  cell in an auto-layout table is only a suggestion; both columns now carry `min-width` plus
  `white-space: nowrap` and render at 104 px and 92 px.
- The history table overflowed its 562 px panel by 18 px and cut the hash in the Reference cell
  ("DEMO DATA 0x…"); the panel now fits exactly, with the demo badge stacked above the hash.
- `#modal-root` was only addressable by an ID while the stylesheet defined `.modal-backdrop`/`.scrim`
  classes, so confirmation dialogs rendered as unstyled markup appended to the document body. The
  overlay, backdrop, card, confirm rows and warning block are now styled.
- The hero title carried `max-width: 34ch`, and a `ch` unit is measured in the element's own font —
  it capped the headline at roughly 13 CJK characters and left most of its column empty. Measures are
  now expressed in rem via `--measure-prose` / `--measure-lead` / `--measure-narrow`.

### Known limitations (documented, not fixed in v1.0)
- No price oracle: debt and collateral are both ETH-denominated, so there is no cross-asset
  liquidation risk and no health-factor monitoring.
- A partially funded `Pending` loan has no borrower exit; `cancelLoan` requires `amountFunded == 0`.
- `initialize` is first-caller-wins, so deployment must call it in the same script run.
- Unaudited; Sepolia testnet only.
