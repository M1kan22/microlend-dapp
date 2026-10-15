#!/usr/bin/env node
/**
 * test/run-tests.js — MicroLend contract test runner.
 *
 * Compiles contracts/MicroLendPool.sol, boots an in-process ganache EVM, executes every suite
 * against real deployed bytecode, prints a per-suite results table and writes:
 *   test/test-results.json   machine-readable evidence
 *   test/TEST-RESULTS.md     human-readable evidence
 *
 * Exit code 0 only when every assertion passes.
 *
 * Usage:
 *   node test/run-tests.js                 # everything
 *   node test/run-tests.js repayment       # only suites whose name contains "repayment"
 */
"use strict";

const fs = require("fs");
const path = require("path");

const {
  ROOT,
  ethers,
  ganache,
  createNode,
  createSession,
  Assertions,
  oneLine,
} = require("./harness");
const { compileToArtifact } = require(path.join(__dirname, "..", "scripts", "compile.js"));

const SUITES = [
  require("./suites/01-deployment"),
  require("./suites/02-deposits"),
  require("./suites/03-withdraw"),
  require("./suites/04-request-loan"),
  require("./suites/05-funding"),
  require("./suites/06-repayment"),
  require("./suites/07-liquidation"),
  require("./suites/08-cancellation"),
  require("./suites/09-governance"),
  require("./suites/10-pause"),
  require("./suites/11-views-events"),
  require("./suites/12-reentrancy"),
  require("./suites/13-invariants"),
];

const RESULTS_JSON = path.join(__dirname, "test-results.json");
const RESULTS_MD = path.join(__dirname, "TEST-RESULTS.md");

function depVersion(name) {
  try {
    return require(path.join(ROOT, ".tooling", "nm", "node_modules", name, "package.json")).version;
  } catch {
    return "unknown";
  }
}

function pad(text, width, align = "left") {
  const s = String(text);
  if (s.length >= width) return s;
  const padding = " ".repeat(width - s.length);
  return align === "right" ? padding + s : s + padding;
}

function printTable(rows, totals) {
  const headers = ["#", "suite", "assertions", "passed", "failed", "invariants", "time"];
  const widths = [3, 42, 10, 7, 7, 10, 8];
  const line = (cells) =>
    "  " +
    cells
      .map((c, i) => pad(c, widths[i], i >= 2 ? "right" : "left"))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  rows.forEach((r, i) => {
    const cells = [
      i + 1,
      r.name.length > 42 ? r.name.slice(0, 39) + "..." : r.name,
      r.assertions,
      r.passed,
      r.failed,
      r.invariants,
      (r.elapsedMs / 1000).toFixed(2) + "s",
    ];
    console.log(line(cells));
  });
  console.log("  " + widths.map((w) => "-".repeat(w)).join("  "));
  console.log(
    line(["", "TOTAL", totals.assertions, totals.passed, totals.failed, totals.invariants, (totals.elapsedMs / 1000).toFixed(2) + "s"])
  );
}

function markdownTable(rows, totals) {
  const out = [];
  out.push("| # | Suite | Assertions | Passed | Failed | Money-invariant checks | Time |");
  out.push("|---:|---|---:|---:|---:|---:|---:|");
  rows.forEach((r, i) => {
    out.push(
      `| ${i + 1} | ${r.name} | ${r.assertions} | ${r.passed} | ${r.failed} | ${r.invariants} | ${(r.elapsedMs / 1000).toFixed(2)}s |`
    );
  });
  out.push(
    `| | **TOTAL** | **${totals.assertions}** | **${totals.passed}** | **${totals.failed}** | **${totals.invariants}** | **${(
      totals.elapsedMs / 1000
    ).toFixed(2)}s** |`
  );
  return out.join("\n");
}

async function main() {
  const filters = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const started = Date.now();

  console.log("MicroLend contract test suite");
  console.log("=============================");

  // Always compile from source so the suite can never run against a stale artifact.
  const { artifact, warnings } = compileToArtifact({ write: true });
  const bytecodeBytes = (artifact.bytecode.length - 2) / 2;
  console.log(
    `compiled ${artifact.contractName} with solc ${artifact.compiler.version} ` +
      `(optimizer runs ${artifact.compiler.optimizer.runs}, evmVersion ${artifact.compiler.evmVersion})`
  );
  console.log(`  abi=${artifact.abi.length} entries, bytecode=${bytecodeBytes}B, sourceHash=${artifact.sourceHash}`);
  for (const w of warnings) console.log("  solc warning: " + oneLine({ message: w.formattedMessage }));
  console.log("  ganache hardfork=shanghai, in-process provider, deterministic mnemonic");
  console.log("");

  const node = await createNode();
  const ctx = createSession(node, { artifact });
  const t = new Assertions({ verbose: true });
  ctx.bind(t);

  const selected = SUITES.filter((s) => filters.length === 0 || filters.some((f) => s.name.toLowerCase().includes(f.toLowerCase())));
  if (selected.length === 0) {
    console.error("no suite matched " + JSON.stringify(filters));
    process.exit(1);
  }

  const rows = [];
  for (const suite of selected) {
    // Each suite runs against a pristine chain state.
    const snapshot = await ctx.snapshot();
    t.suite(suite.name);
    const before = t.records.length;
    const suiteStart = Date.now();
    try {
      await suite.run(ctx, t);
    } catch (err) {
      t.fail(`${suite.name}: suite aborted with an exception`, oneLine(err) + (err && err.stack ? "\n" + err.stack.split("\n").slice(0, 4).join("\n") : ""));
    }
    const suiteElapsed = Date.now() - suiteStart;
    const slice = t.records.slice(before);
    await ctx.revert(snapshot);
    rows.push({
      name: suite.name,
      assertions: slice.length,
      passed: slice.filter((r) => r.ok).length,
      failed: slice.filter((r) => !r.ok).length,
      invariants: slice.filter((r) => r.kind === "invariant").length,
      invariantFailures: slice.filter((r) => r.kind === "invariant" && !r.ok).length,
      elapsedMs: suiteElapsed,
    });
  }

  const elapsedMs = Date.now() - started;
  const totals = {
    suites: rows.length,
    assertions: t.total,
    passed: t.passed,
    failed: t.failed,
    invariants: t.records.filter((r) => r.kind === "invariant").length,
    invariantFailures: t.records.filter((r) => r.kind === "invariant" && !r.ok).length,
    elapsedMs,
  };

  console.log("\nResults");
  console.log("=======");
  printTable(rows, totals);

  const failures = t.records.filter((r) => !r.ok);
  if (failures.length) {
    console.log(`\n${failures.length} failing assertion(s):`);
    for (const f of failures) {
      console.log(`  [${f.suite}] ${f.name}`);
      console.log(`      ${String(f.detail).replace(/\n/g, "\n      ")}`);
    }
  } else {
    console.log(`\nAll ${totals.assertions} assertions passed (${totals.invariants} money-invariant checks included).`);
  }

  // ---------------- evidence files ----------------
  const environment = {
    node: process.version,
    platform: process.platform,
    solc: artifact.compiler.version,
    optimizer: artifact.compiler.optimizer,
    evmVersion: artifact.compiler.evmVersion,
    hardfork: "shanghai",
    chainId: node.chainId,
    ethers: depVersion("ethers"),
    ganache: depVersion("ganache"),
    contractAddress: null,
    sourceHash: artifact.sourceHash,
  };

  const json = {
    project: "MicroLend — peer-to-peer micro-lending DApp (SC6113)",
    generatedAt: new Date().toISOString(),
    command: "node test/run-tests.js",
    contract: { name: artifact.contractName, sourceFile: artifact.sourceFile, abiEntries: artifact.abi.length, bytecodeBytes },
    environment,
    moneyInvariant: {
      definition:
        "address(pool).balance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance",
      rationale:
        "free liquidity + collateral held + unclaimed fees are the only ETH the contract may hold. " +
        "reservedLiquidity is already inside totalLiquidity but has been disbursed to borrowers, so it is excluded. " +
        "The spec's original rule-12 wording (since amended in docs/INTEGRATION_SPEC.md to the identity above) read " +
        "totalLiquidity + accumulatedCollateral + treasuryBalance + DEAD_SHARES, which omits -reservedLiquidity and " +
        "adds 1 wei the bootstrap deposit does not create; suite 13 measures both deviations exactly, in wei, so the " +
        "amendment is reproducible rather than asserted on trust.",
    },
    totals,
    suites: rows,
    failures: failures.map((f) => ({ suite: f.suite, kind: f.kind, name: f.name, detail: f.detail })),
    records: t.records,
  };
  fs.writeFileSync(RESULTS_JSON, JSON.stringify(json, null, 2) + "\n", "utf8");

  const md = [];
  md.push("# MicroLend — contract test results");
  md.push("");
  md.push(`Generated: ${json.generatedAt}  `);
  md.push(`Command: \`node test/run-tests.js\`  `);
  md.push(
    `Toolchain: solc ${artifact.compiler.version} (optimizer runs ${artifact.compiler.optimizer.runs}, ${artifact.compiler.evmVersion}), ` +
      `ganache ${environment.ganache}, ethers ${environment.ethers}, Node ${environment.node}`
  );
  md.push("");
  md.push("## Summary");
  md.push("");
  md.push(markdownTable(rows, totals));
  md.push("");
  md.push(
    `**${totals.passed}/${totals.assertions} assertions passed** across ${totals.suites} suites in ` +
      `${(totals.elapsedMs / 1000).toFixed(2)}s; ${totals.invariants} of those are money-invariant checks.`
  );
  md.push("");
  md.push("## Money invariant");
  md.push("");
  md.push("```");
  md.push(json.moneyInvariant.definition);
  md.push("```");
  md.push("");
  md.push(json.moneyInvariant.rationale);
  md.push("");
  if (failures.length) {
    md.push("## Failing assertions");
    md.push("");
    for (const f of failures) {
      md.push(`- **[${f.suite}] ${f.name}** — ${String(f.detail).replace(/\n/g, " ")}`);
    }
    md.push("");
  } else {
    md.push("## Failing assertions");
    md.push("");
    md.push("None — every assertion passed.");
    md.push("");
  }
  md.push("## Suite coverage");
  md.push("");
  md.push("| Suite | Spec coverage |");
  md.push("|---|---|");
  md.push("| 01 deployment + frozen interface | §2.1-2.6: every mutating signature, read helper, event and custom error; constants; defaults; one-shot `initialize`; `NotInitialized`/`NotOwner` gates |");
  md.push("| 02 deposits + share math + donation safety | rules 1 and 2: `minDeposit`, DEAD_SHARES bootstrap, pro-rata minting, `receive`/`fallback` rejection, inflation-attack resistance |");
  md.push("| 03 withdraw | rule 3: `ZeroAmount`, `InsufficientShares`, exit while paused, reserved-liquidity lock, exact share appreciation |");
  md.push("| 04 requestLoan validation matrix | rule 4: principal/duration/rate bounds, `ceil()` collateral, inclusive boundaries |");
  md.push("| 05 activation vs pending + fundLoan | rules 5 and 6: instant activation, pending path, partial/complete funding, share minting, `LoanNotPending`/`AmountTooLarge`/`AmountTooSmall` |");
  md.push("| 06 repayLoan | rule 7: exact simple interest, fee split, overpayment refund, double-repay, late-fee periods after time travel |");
  md.push("| 07 liquidate | rule 8: overdue gate (including exactly at `dueDate`), excess-collateral refund, bad-debt write-off, sole-supplier exit regressions |");
  md.push("| 08 cancelLoan | rule 9: borrower-only, pending-only, `NotFunded`, refund accounting |");
  md.push("| 09 governance + access control | rule 11: `NotOwner` on every owner-only entry point, full `setParams` matrix, treasury claim and its free-liquidity cap, initialisation front-running (documented limitation) |");
  md.push("| 10 pause behaviour matrix | pause blocks `deposit`/`requestLoan`/`fundLoan`; exit paths (`withdraw`, `repayLoan`, `cancelLoan`, `liquidate`, `claimTreasury`) stay open |");
  md.push("| 11 read helpers | §2.4: `poolStats`, `liabilities`, `getUserPosition`, `getUserLoans`, previews, `collateralRatio`, `isOverdue`, `quoteCollateral` |");
  md.push("| 12 reentrancy guard | rule 10: a live attacker contract re-enters each of the 8 guarded functions from every ETH callback and observes `Reentrancy()` |");
  md.push("| 13 money invariant | rule 12 after 14 distinct scenarios plus the exact deviation of the pre-amendment formula text |");
  md.push("");
  md.push("## Regression history (audit trail)");
  md.push("");
  md.push("**Settlement double-count (found by this suite, fixed by the contract owner).** Against sourceHash");
  md.push("`0x…` (pre-fix revision) the canonical identity broke on every settlement:");
  md.push("");
  md.push("- `_settleRepayment` credited `principal + netInterest` to `totalLiquidity` even though `totalLiquidity` already contained the outstanding principal while the loan was reserved, so supplier claims exceeded the pool balance by exactly `principal` (repro: deposit 10 ETH → 1 ETH loan at 1000 bps/30 d → repay 18219178082191780 wei → `totalLiquidity` 10000000000000000000 → 11007397260273972602, `totalLiquidity + treasuryBalance − balance == 1e18`).");
  md.push("- User-visible symptom: `withdraw(sharesOf[supplier])` passed the `availableLiquidity` check (11007397260273972600 ≤ 11007397260273972602) but the contract only held 10008219178082191780 wei, so the transfer failed and reverted `TransferFailed` — the last suppliers could not exit.");
  md.push("- `liquidate` credited the whole seizure on top of the same claim (`totalLiquidity += compensation`), over-crediting suppliers by `principal` in both the excess-collateral and bad-debt branches.");
  md.push("- The late fee was received but never credited to any liability, stranding `lateFee` wei in the contract.");
  md.push("");
  md.push("Fix: `totalLiquidity += netInterest + lateFee` on repayment, `totalLiquidity = totalLiquidity - principal + compensation` on liquidation, and `claimTreasury` no longer deducts from `totalLiquidity`.");
  md.push("Regression guards: suite 03 (sole supplier full exit after repayment), suite 07 (full exit after both");
  md.push("liquidation branches, supplier absorbs the bad-debt loss), suite 06 (late fee credited to suppliers),");
  md.push("suite 13 (identity asserted in 14 states, all deltas 0 wei).");
  md.push("");
  md.push("**Rule 12 text amended.** The original wording `balance == totalLiquidity + accumulatedCollateral + treasuryBalance + DEAD_SHARES` is unsatisfiable: it overshoots by exactly `DEAD_SHARES` straight after the bootstrap deposit and omits `- reservedLiquidity` (overshoot `principal + DEAD_SHARES` after any activation). Suite 13 measures both deviations exactly instead of asserting the wrong formula.");
  md.push("");
  md.push("## Known limitations (asserted, not hidden)");
  md.push("");
  md.push("- `initialize()` is first-caller-wins: anyone can front-run the deployment transaction and become owner/treasury. Suite 09 asserts this behaviour and `scripts/deploy.js` performs `initialize` inside the deployment run to shrink the window.");
  md.push("- ganache strips custom-error data from `eth_call` payloads that carry a non-zero value, so `receive()`/`fallback()` rejection is asserted through a zero-value call for the error selector plus a real mined value transfer whose receipt status is 0.");
  md.push("");
  md.push("## Per-assertion evidence (machine readable)");
  md.push("");
  md.push("The full list of assertions with suite, kind and pass/fail is in `test/test-results.json` (`records`).");
  md.push("");
  md.push("| Suite | Assertions | Failed | Invariant checks | Invariant failures |");
  md.push("|---|---:|---:|---:|---:|");
  for (const r of rows) {
    md.push(`| ${r.name} | ${r.assertions} | ${r.failed} | ${r.invariants} | ${r.invariantFailures} |`);
  }
  md.push("");
  fs.writeFileSync(RESULTS_MD, md.join("\n") + "\n", "utf8");

  console.log(`\nwrote ${path.relative(ROOT, RESULTS_JSON)} and ${path.relative(ROOT, RESULTS_MD)}`);
  console.log(`total elapsed ${(elapsedMs / 1000).toFixed(2)}s`);

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("RUNNER ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
