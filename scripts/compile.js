#!/usr/bin/env node
/**
 * scripts/compile.js — Solidity build step for the MicroLend DApp.
 *
 * Compiles contracts/MicroLendPool.sol with the pinned toolchain (solc 0.8.24, optimizer
 * enabled with 200 runs, evmVersion "shanghai") and writes
 * artifacts/MicroLendPool.json = { contractName, compiler, sourceHash, abi, bytecode,
 * deployedBytecode }.  No Hardhat / Truffle / npm install required: solc, ethers and
 * ganache are pre-installed under .tooling/nm/node_modules.
 *
 * Usage:
 *   node scripts/compile.js            # compile + write artifact
 *   node scripts/compile.js --check    # compile only, fail if the artifact is stale
 *
 * The module also exports compileToArtifact() so test/run-tests.js can guarantee that the
 * suite always runs against the current contracts/ source.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const MODULES_ROOT = path.join(ROOT, ".tooling", "nm", "node_modules");
const SOURCE_FILE = path.join(ROOT, "contracts", "MicroLendPool.sol");
const SOURCE_KEY = "contracts/MicroLendPool.sol";
const ARTIFACT_FILE = path.join(ROOT, "artifacts", "MicroLendPool.json");
const CONTRACT_NAME = "MicroLendPool";
const SOLC_VERSION = "0.8.24";
const OPTIMIZER = { enabled: true, runs: 200 };
const EVM_VERSION = "shanghai";

function loadSolc() {
  return require(path.join(MODULES_ROOT, "solc"));
}

function sha256(text) {
  return "0x" + crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/** Compile a source string and return { contract, warnings, errors }. */
function compileSource(source, contractName = CONTRACT_NAME, sourceKey = SOURCE_KEY) {
  const solc = loadSolc();
  const input = {
    language: "Solidity",
    sources: { [sourceKey]: { content: source } },
    settings: {
      optimizer: OPTIMIZER,
      evmVersion: EVM_VERSION,
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };

  let output;
  try {
    output = JSON.parse(solc.compile(JSON.stringify(input)));
  } catch (err) {
    throw new Error("solc failed to produce JSON output: " + err.message);
  }

  const diagnostics = output.errors || [];
  const errors = diagnostics.filter((d) => d.severity === "error");
  const warnings = diagnostics.filter((d) => d.severity === "warning");
  if (errors.length > 0) {
    const err = new Error(
      "Solidity compilation failed with " + errors.length + " error(s):\n" +
        errors.map((e) => e.formattedMessage.trim()).join("\n")
    );
    err.diagnostics = errors;
    throw err;
  }
  const contract = output.contracts?.[sourceKey]?.[contractName];
  if (!contract) {
    throw new Error(`compiler output did not contain ${sourceKey}:${contractName}`);
  }
  return { contract, warnings, sourceKey };
}

/** Build the artifact object (pure). */
function buildArtifact(source) {
  const { contract, warnings } = compileSource(source);
  return {
    artifact: {
      contractName: CONTRACT_NAME,
      sourceFile: SOURCE_KEY,
      sourceHash: sha256(source),
      compiler: {
        version: SOLC_VERSION,
        optimizer: { enabled: OPTIMIZER.enabled, runs: OPTIMIZER.runs },
        evmVersion: EVM_VERSION,
      },
      abi: contract.abi,
      bytecode: "0x" + contract.evm.bytecode.object,
      deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
    },
    warnings,
  };
}

/**
 * Compile contracts/MicroLendPool.sol and (by default) persist artifacts/MicroLendPool.json.
 * @returns {{artifact: object, warnings: object[], source: string, written: boolean}}
 */
function compileToArtifact({ write = true } = {}) {
  const source = fs.readFileSync(SOURCE_FILE, "utf8");
  const { artifact, warnings } = buildArtifact(source);
  let written = false;
  if (write) {
    fs.mkdirSync(path.dirname(ARTIFACT_FILE), { recursive: true });
    fs.writeFileSync(ARTIFACT_FILE, JSON.stringify(artifact, null, 2) + "\n", "utf8");
    written = true;
  }
  return { artifact, warnings, source, written };
}

function readArtifact() {
  if (!fs.existsSync(ARTIFACT_FILE)) return null;
  return JSON.parse(fs.readFileSync(ARTIFACT_FILE, "utf8"));
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const started = Date.now();
  const { artifact, warnings, written } = compileToArtifact({ write: !checkOnly });
  const elapsed = Date.now() - started;

  for (const w of warnings) {
    console.log("warning: " + String(w.formattedMessage || w.message).split("\n")[0]);
  }

  const bytecodeBytes = (artifact.bytecode.length - 2) / 2;
  const deployedBytes = (artifact.deployedBytecode.length - 2) / 2;
  console.log(
    `MicroLendPool compiled OK  solc=${SOLC_VERSION} optimizer=runs:${OPTIMIZER.runs} ` +
      `evmVersion=${EVM_VERSION} abi=${artifact.abi.length} entries ` +
      `bytecode=${bytecodeBytes}B deployed=${deployedBytes}B sourceHash=${artifact.sourceHash}`
  );
  if (written) {
    console.log(`artifact written: ${path.relative(ROOT, ARTIFACT_FILE)}`);
  } else {
    const existing = readArtifact();
    const stale = !existing || existing.sourceHash !== artifact.sourceHash;
    console.log(`check mode: artifact ${stale ? "STALE/MISSING" : "up-to-date"}`);
    if (stale) process.exit(1);
  }
  console.log(`elapsed ${elapsed}ms`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = {
  compileSource,
  buildArtifact,
  compileToArtifact,
  readArtifact,
  SOURCE_FILE,
  ARTIFACT_FILE,
  CONTRACT_NAME,
  SOLC_VERSION,
  OPTIMIZER,
  EVM_VERSION,
  ROOT,
  MODULES_ROOT,
};
