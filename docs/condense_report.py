"""Condense docs/REPORT.md from ~16 PDF pages to within the assignment's 5-8 page limit.

Strategy: keep every required section in the assignment's order, keep the argument and the
headline numbers, and replace the verbatim evidence dumps (which already live in
docs/TESTING.md) with a compact table plus a pointer. Front-matter code listings and long
command blocks are trimmed the same way.

Run:  python docs/condense_report.py          # rewrites docs/REPORT.md in place
      python docs/condense_report.py --check  # report the word budget only
"""
from __future__ import annotations

import argparse
import io
import re
import sys

PATH = "docs/REPORT.md"


def split_sections(text: str) -> tuple[str, list[tuple[str, str]]]:
    parts = re.split(r"^(##\s+.*)$", text, flags=re.M)
    front = parts[0]
    sections = [(parts[i].strip(), parts[i + 1]) for i in range(1, len(parts), 2)]
    return front, sections


def words(text: str) -> int:
    return len(re.findall(r"\S+", re.sub(r"```.*?```", "", text, flags=re.S)))


CONDENSED = {
    # ---------------------------------------------------------------- 3. Objectives
    "## 3. Objectives": """## 3. Objectives

The deliverable is measured against six testable objectives, each of which is evidenced
elsewhere in this report and in `docs/TESTING.md`.

| # | Objective | Acceptance test | Result |
|---|---|---|---|
| O1 | Implement an original DeFi protocol, not a template wrapper | a single self-contained Solidity contract with its own state machine | `contracts/MicroLendPool.sol`, 707 lines, zero imports |
| O2 | Price credit deterministically without an oracle | interest, fee and liquidation arithmetic reproducible to the wei | 811/811 contract assertions on an in-process EVM |
| O3 | Make every fund movement auditable by a supplier | a money invariant asserted after every scenario | `cash == (totalLiquidity - reserved) + collateral + fees`, 0 wei drift in 14 scenarios |
| O4 | Integrate an unmodified browser wallet | connect, network switch, signature login, tx signing | MetaMask RPC surface exercised in demo and chain mode |
| O5 | Show that off-chain code agrees with the chain | three-way ABI and quote parity | contract / backend / frontend = 102 / 102 / 102 entries, 0 differences |
| O6 | Be usable and gradeable without testnet funds | an offline demo that mirrors the contract exactly | `frontend/js/demo.js`; four named vectors match the chain bit-for-bit |
""",
    # ------------------------------------------------- 6. Smart Contract Design
    "## 6. Smart Contract Design": """## 6. Smart Contract Design

MicroLend is one contract with one job: convert supplied ETH into loans and back again without
ever losing track of who owns what.

**Actors and lifecycle.** A *supplier* calls `deposit()` and receives pool shares; a *borrower*
calls `requestLoan(principal, rateBps, durationDays)` with collateral attached; anyone may
`fundLoan()` a request the pool cannot cover, or `liquidate()` an overdue loan. The owner may
only change parameters, pause new lending and claim the protocol fee.

```
LoanStatus: None -> Pending -> Active -> Repaid
                      |          |
                      |          +--> Liquidated   (past dueDate, unpaid)
                      +--> Cancelled               (borrower, while unfunded)
```

**Arithmetic.** Interest is simple, pro-rated over a 365-day year, and frozen when the loan is
created:

```
interestWei = principal * rateBps * durationDays / (10_000 * 365)
amountDue   = principal + interestWei                       (on time)
lateFee     = amountDue * lateFeeBps * periods / 10_000     periods = started 30-day periods late
fee         = interestWei * feeBps / 10_000                 feeBps default 1_000 (10% of interest)
```

On repayment the pool credits `netInterest + lateFee` to `totalLiquidity` — the principal was
already a supplier claim held in `reservedLiquidity`, so crediting it again would create claims
the contract could not honour. That exact mistake was made, caught by two independent reviewers
and fixed; the sequence is recorded in §9.4 and in `docs/CHANGELOG.md`. On liquidation the claim
settles as `totalLiquidity - principal + compensation`, which makes suppliers the residual
claimant and lets them genuinely bear a default shortfall.

**Share accounting.** Shares are 1:1 with wei on the first deposit, which also parks one *dead
share* on the contract. That single share is what defeats the classic first-depositor inflation
attack: an attacker cannot raise the share price by donating, because a donation lifts the value
of the dead share too, and the victim's mint is computed against the inflated book.

**Security.** Every state-changing entry point is non-reentrant and follows checks-effects-
interactions; ETH leaves only through a low-level `call` whose status is checked. Inputs are
range-checked against live parameters (`minDeposit`, `minLoanPrincipal`, `maxLoanPrincipal`,
`maxDurationDays`, `maxRateBps`, `minCollateralBps`), and 25 distinct custom errors make each
failure mode machine-readable. `receive()` and `fallback()` revert, so ETH cannot be donated into
the pool by accident. Gas is managed with `constant` tables, custom errors instead of revert
strings, and tight packing of the `Loan` struct.

| Design decision | Why it is safe |
|---|---|
| ETH-only denomination | no oracle in the critical path; a stale price cannot trigger a bad liquidation |
| Interest frozen at origination | the borrower's obligation cannot be changed mid-loan by an owner parameter edit |
| Collateral pooled in-contract | liquidation needs no external transfer or approval step |
| Protocol fee capped at 20% of interest | `setParams` cannot set a fee that drains principal |
| Owner cannot withdraw user funds | `claimTreasury` is limited to `treasuryBalance`, itself bounded by realised interest |
""",
    # ------------------------------------------- 7. Application Design (trim code)
    "## 7. Application Design": """## 7. Application Design

**System shape.** Four layers, each replaceable: the browser client, a Flask indexing service, a
chain, and the contract.

```
browser (MetaMask)                     Flask API                    chain
-----------------                      ---------                    -----
frontend/js/*  -- personal_sign ---->  POST /api/auth/*  ---+
               -- eth_sendTransaction -> (token)                |
ethers.Contract ---- RPC -------------------------------------+--> MicroLendPool
               <--- events/receipts ---  SQLite index  <--- receipts
```

**Trust boundary.** The Flask service never sees a private key. A wallet authenticates by signing
a single-use nonce; the backend recovers the signer with a pure-Python secp256k1 `ecrecover`,
issues an HMAC bearer token, and thereafter refuses any write whose transaction sender is not the
authenticated address. Every indexed write re-reads the receipt from the chain, requires
`status == 1`, and refuses to record anything it cannot reconcile with the decoded event — so the
database is a cache of chain facts, never a source of them.

**Client.** Plain HTML/CSS/JS with `window.ML_*` globals and no build step, so the submission
runs by opening a file. `frontend/js/demo.js` mirrors the contract arithmetic against a
`localStorage` ledger, which is what makes the DApp fully demonstrable with no wallet and no
testnet funds; a badge and a banner mark every demo surface so the two modes cannot be confused.

| Panel | Purpose |
|---|---|
| Pool instrument | utilisation gauge, borrowed vs available, share price |
| Supply / withdraw | deposit ETH, mint shares, redeem against free liquidity |
| Open a loan | principal, rate, term and collateral with a live quote and validation |
| Loan book | every loan with status, live amount due and the actions its state allows |
| Position and history | the connected account's claims, plus the indexed transaction log |
| Protocol parameters | owner-only parameter, pause and treasury controls, disabled for others |
""",
    # ---------------------------------------- 8. Implementation (trim to essentials)
    "## 8. Implementation": """## 8. Implementation

| Artifact | Scale | Notes |
|---|---|---|
| `contracts/MicroLendPool.sol` | 707 lines | 61 ABI functions, 14 events, 25 custom errors, no imports |
| `backend/` | 14 modules | 19 REST routes, SQLite index, signature auth, validation, seeding |
| `frontend/` | 16 files | dashboard, demo engine, wallet integration, two test suites |
| `test/` | 13 suites | 811 assertions on a real EVM, 14 money-invariant checks |
| `scripts/` | 8 scripts | compile, deploy (Sepolia), dev chain, local seed, capture, measure, package |

Build and verification commands:

```powershell
node scripts/compile.js        # solc 0.8.24 (optimizer runs 200, shanghai) -> artifacts/
node test/run-tests.js         # 811 assertions on an in-process ganache chain
python -m pytest backend/tests -q     # 122 backend tests
node scripts/deploy-local.js   # local chain + seeded pool + deployment.local.json
node scripts/deploy.js         # Sepolia deploy, then initialize() in the same run
```

The contract compiles to 12 471 bytes of creation bytecode with no external dependency, so the
deployed artifact is reproducible from the source hash recorded in `docs/TESTING.md`.
""",
    # ------------------------------------- 9. Testing and Results (the big cut)
    "## 9. Testing and Results": """## 9. Testing and Results

Testing is layered so that a passing claim at one layer is not taken on trust by the next. All
figures below were produced by commands in this repository; the verbatim output, the endpoint
matrix and the decoded custom-error table live in `docs/TESTING.md`.

| Layer | Command | Result |
|---|---|---|
| Contract, real EVM | `node test/run-tests.js` | **811 / 811 assertions**, 0 failed, 14 money-invariant checks, 0 drift, 13 suites |
| Backend unit and API | `python -m pytest backend/tests -q` | **122 passed** (449 `assert` statements, 6 `pytest.raises`) |
| Client | `node frontend/tests/*.test.mjs` | **both suites pass**; parity vectors and a full UI cycle with zero console errors |
| End to end, chain mode | `node scripts/integration-e2e.js` | **38 / 38**: live chain + live Flask, real receipt decoded and indexed |
| Compile check | `node scripts/compile.js` | ABI 102 entries, source hash matches the pinned revision |

**Contract suite.** Thirteen suites cover the twelve behavioural rules in
`docs/INTEGRATION_SPEC.md` §2.7: deployment and the frozen interface, deposits and share maths,
withdrawal (including that withdrawal stays available while new lending is paused), the full
`requestLoan` revert matrix, pending-versus-active activation, `fundLoan`, repayment to the wei
including both late-fee periods, both liquidation branches, cancellation, governance and access
control, the pause matrix, the read helpers, a live re-entrancy attacker, and the money invariant
after every scenario. Exactness is asserted rather than approximated: 1 ETH at 1 000 bps for 30
days is 8 219 178 082 191 780 wei of interest, and a supplier's profit is `netInterest - 2 wei` of
rounding dust.

**Backend suite.** Every documented route is exercised on its happy path plus at least one
invalid request, with authentication required, invalid, expired and revoked; per-field validation
errors; duplicate-hash conflicts; pagination; sender-mismatch rejection; and decimal money paths
proved never to use binary floating point.

**End-to-end run.** Against a real EVM over HTTP and a real Flask server, the run authenticated
with `personal_sign`, fetched a real transaction receipt, decoded its `LiquidityDeposited` log,
persisted it and read it back — and proved the negative cases: a write without a token is `401`,
a transaction sent by a different wallet than the session is rejected, a replayed hash is `409`,
and a submitted amount that disagrees with the chain is refused with both values quoted.

**Gas.** Deployment costs 12 471 bytes of creation code. A deposit, a loan request that activates
in the same transaction, a repayment and a liquidation each stay comfortably inside a standard
block, and the contract uses custom errors rather than revert strings specifically to keep failure
paths cheap. Absolute gas figures are recorded in `docs/TESTING.md` §5.

### 9.4 Findings from independent review

Two reviewers reproduced results independently — one drove real transactions on an in-process EVM,
the other built its own harness — and between them found four genuine defects in the first draft
of the contract plus one unsatisfiable specification clause. All are fixed and regression-guarded.

| ID | Severity | Defect | User-visible symptom | Status |
|---|---|---|---|---|
| F-01 | High | repayment credited the disbursed principal a second time | the only supplier could not withdraw their whole balance: the availability check passed but the transfer reverted | fixed, re-verified |
| F-02 | High | liquidation added the seizure without releasing the principal claim | supplier claims exceeded cash on both liquidation branches | fixed, re-verified |
| F-03 | Medium | late fee was charged but credited to no claimant | ETH stranded in the contract with no owner | fixed, re-verified |
| F-04 | Medium | `claimTreasury` also debited the supplier claim | suppliers paid the protocol fee twice | fixed, re-verified |
| F-05 | Medium | the specification's invariant was unsatisfiable as written | test and documentation disagreed | corrected in `docs/INTEGRATION_SPEC.md` §2.7 |
| F-06 | Medium | a 50 % collateral floor contradicted the older `< 100 %` rule | ambiguity about intended collateral policy | intended; rationale documented |
| F-07 | Low | `initialize` is first-caller-wins | a front-runner could claim ownership at deploy time | accepted limitation; deployment initialises in the same run |
| F-08 | Medium | a partly funded pending loan has no borrower exit | collateral is locked until the request is fully funded | accepted for v1.0; timeout design in §12 |

The corrected invariant, asserted after every scenario, is:

```
address(pool).balance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance
```

**Coverage limits.** No third-party audit, fuzzing or formal verification was performed. The
Sepolia deployment is scripted but was not broadcast in the authoring environment (no funded key
or RPC endpoint), so chain interaction is verified on a local EVM. Browser rendering was checked
by screenshotting the real page through a headless engine; MetaMask itself was not driven
interactively.
""",
    # --------------------------------- 10. Challenges (trim to compact prose)
    "## 10. Challenges Encountered": """## 10. Challenges Encountered

**Correctness under review was the real test.** The most valuable failure was not a compile error
but an accounting bug: `_settleRepayment` credited the principal a second time, so the contract
promised more than it held. It compiled, it passed a naive test, and it was invisible until a
reviewer asked the contract to pay a supplier in full. It is now covered by a regression that
withdraws the entire book and asserts the pool drains to exactly its remaining liabilities.

**Making settlement auditable.** Deciding *where* the principal claim lives — supplier claim
(`totalLiquidity`) or reservation (`reservedLiquidity`) — took three attempts and produced the
single invariant the whole test suite is now built around. Specification text was wrong before the
code was: the first invariant omitted `reservedLiquidity` and double-counted the dead share by one
wei, which a reviewer measured rather than assumed.

**Tooling on a locked-down machine.** `pip install --target` failed with `PermissionError` because
the sandbox refuses writes inside the mode-0700 directories `tempfile.mkdtemp()` creates. Flask
and pytest were installed by fetching wheels from the PyPI JSON API and unzipping them. Later,
generating this report's PDF required the same care: the sandbox blocks a Python process from
spawning a piped child, so the DOCX is built by `python-docx` and the PDF conversion runs with
wider access.

**Browser verification.** Chromium's multi-process IPC needs named pipes, which the sandbox
denies. Rather than ship an unverified `<style>` rewrite, the layout was fixed by measuring the
rendered page through the DevTools protocol: that is how a 34.6 px Status column (one letter per
line) and a 27.1 px Loan column were found and corrected.
""",
    # ---------------------------------------- 11. Limitations (compact)
    "## 11. Limitations": """## 11. Limitations

| Limitation | Consequence |
|---|---|
| No price oracle | debt and collateral are both ETH-denominated, so there is no cross-asset liquidation and no health factor to monitor |
| 100 % collateral required by default | capital-inefficient relative to pooled credit; lowering the floor to 50 % admits real bad debt, which the protocol books rather than reverts on |
| A single liquidity pool | suppliers cannot choose a risk tranche or a specific borrower |
| Interest is fixed at origination | no floating or utilisation-based rate |
| Pending loans have no timeout | a partly funded request locks the borrower's collateral until it is filled or cancelled while unfunded |
| First-caller-wins `initialize` | safe only if deployment initialises in the same run, which `scripts/deploy.js` does |
| Unaudited, testnet only | not suitable for mainnet or real funds |
| No third-party audit, fuzzing or formal verification | correctness rests on the test suite and adversarial review, not proof |
""",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report the word budget only")
    args = parser.parse_args()

    text = io.open(PATH, encoding="utf-8").read()
    front, sections = split_sections(text)

    before = words(text)
    out = []
    changed = []
    for title, body in sections:
        if title in CONDENSED:
            out.append(title + "\n" + CONDENSED[title].split("\n", 1)[1])
            changed.append(title)
        else:
            out.append(title + body)

    rebuilt = front + "".join(out)
    after = words(rebuilt)

    print(f"sections condensed : {len(changed)}")
    for c in changed:
        print("   ", c)
    print(f"words before/after : {before} -> {after}")

    if args.check:
        return 0

    io.open(PATH, "w", encoding="utf-8", newline="").write(rebuilt)
    print(f"rewrote {PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
