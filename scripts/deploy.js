#!/usr/bin/env node
/**
 * scripts/deploy.js — deploy MicroLendPool to the Ethereum Sepolia testnet.
 *
 * Uses plain ethers v6 (no Hardhat / Truffle). Reads configuration from the environment,
 * optionally loading a `.env` file from the project root (existing environment variables win):
 *
 *   SEPOLIA_RPC_URL         required — e.g. https://sepolia.infura.io/v3/<key>
 *   DEPLOYER_PRIVATE_KEY    required — funded Sepolia key (0x-prefixed)
 *   TREASURY_ADDRESS        optional — defaults to the deployer
 *   OWNER_ADDRESS           optional — defaults to the deployer
 *   DEPLOYMENT_OUT          optional — output path, defaults to ./deployment.json
 *
 * The script compiles contracts/MicroLendPool.sol with the pinned toolchain, deploys it and
 * calls initialize(treasury, owner) in the same run (the contract has a proxy-style initialiser
 * and an unfunded pool must never be left half-configured), then writes deployment.json and
 * prints the Sepolia Etherscan links.
 *
 * Usage:
 *   node scripts/deploy.js            # deploy (requires a funded key)
 *   node scripts/deploy.js --dry-run  # validate configuration and print the plan only
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MODULES_ROOT = path.join(ROOT, ".tooling", "nm", "node_modules");
const { ethers } = require(path.join(MODULES_ROOT, "ethers"));
const { compileToArtifact } = require(path.join(__dirname, "compile.js"));
const CFG = require(path.join(__dirname, "chain-config.js"));

const DEFAULT_OUT = path.join(ROOT, "deployment.json");

/** Minimal .env loader: `KEY=value` lines, `#` comments; never overrides the real environment. */
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function fail(message) {
  console.error("deploy: " + message);
  process.exit(1);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const envFileLoaded = loadDotEnv();

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  const outPath = process.env.DEPLOYMENT_OUT ? path.resolve(ROOT, process.env.DEPLOYMENT_OUT) : DEFAULT_OUT;

  console.log("MicroLend — Sepolia deployment");
  console.log("==============================");
  console.log(`RPC URL       : ${rpcUrl ? rpcUrl.replace(/\/v3\/.*$/, "/v3/***") : "(missing)"}`);
  console.log(`Private key   : ${privateKey ? "0x" + privateKey.replace(/^0x/, "").slice(0, 6) + "... (" + privateKey.replace(/^0x/, "").length / 2 + " bytes)" : "(missing)"}`);
  console.log(`.env loaded   : ${envFileLoaded ? "yes" : "no"}`);
  console.log(`Output        : ${path.relative(ROOT, outPath)}`);

  if (!rpcUrl) fail("SEPOLIA_RPC_URL is not set (see .env.example)");
  if (!privateKey) fail("DEPLOYER_PRIVATE_KEY is not set (see .env.example)");
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) fail("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string");
  if (!/^https?:\/\//.test(rpcUrl)) fail("SEPOLIA_RPC_URL must be an http(s) URL");

  // ---- compile (always from source, so a stale artifact can never be deployed) ----
  const { artifact } = compileToArtifact({ write: true });
  console.log(`Compiled      : ${artifact.contractName} solc ${artifact.compiler.version}, abi ${artifact.abi.length} entries`);
  console.log(`Source hash   : ${artifact.sourceHash}`);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CFG.SEPOLIA_CHAIN_ID) {
    fail(`RPC reports chainId ${network.chainId}, expected ${CFG.SEPOLIA_CHAIN_ID} (Sepolia)`);
  }
  const wallet = new ethers.Wallet(privateKey, provider);
  const [balance, feeData, nonce] = await Promise.all([
    provider.getBalance(wallet.address),
    provider.getFeeData(),
    provider.getTransactionCount(wallet.address),
  ]);

  const treasury = process.env.TREASURY_ADDRESS || wallet.address;
  const owner = process.env.OWNER_ADDRESS || wallet.address;
  const etherscan = `${CFG.SEPOLIA_EXPLORER}/address/${wallet.address}`;

  console.log(`Network       : ${CFG.SEPOLIA_CHAIN_NAME} (chainId ${network.chainId})`);
  console.log(`Deployer      : ${wallet.address} (${ethers.formatEther(balance)} ETH, nonce ${nonce})`);
  console.log(`Treasury      : ${treasury}`);
  console.log(`Owner         : ${owner}`);
  console.log(`Gas price     : ${feeData.gasPrice ? feeData.gasPrice.toString() + " wei" : "(unknown)"}`);
  console.log(`Explorer      : ${etherscan}`);

  if (balance === 0n) fail("the deployer has a zero Sepolia balance — fund it from a faucet first");
  if (dryRun) {
    console.log("\n--dry-run: configuration is valid; nothing was deployed.");
    return;
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  console.log("\nSending deployment transaction...");
  const contract = await factory.deploy();
  const deployTx = contract.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  const address = await contract.getAddress();
  console.log(`  deployed at        ${address}`);
  console.log(`  tx                 ${CFG.SEPOLIA_EXPLORER}/tx/${deployTx.hash}`);
  console.log(`  block              ${deployReceipt.blockNumber}`);
  console.log(`  gas used           ${deployReceipt.gasUsed.toString()}`);

  console.log("\nCalling initialize(treasury, owner)...");
  const initTx = await contract.initialize(treasury, owner);
  const initReceipt = await initTx.wait();
  console.log(`  tx                 ${CFG.SEPOLIA_EXPLORER}/tx/${initTx.hash}`);
  console.log(`  block              ${initReceipt.blockNumber}`);

  const [storedOwner, storedTreasury, initialized, loanCount] = await Promise.all([
    contract.owner(),
    contract.treasury(),
    contract.initialized(),
    contract.loanCount(),
  ]);
  if (storedOwner.toLowerCase() !== owner.toLowerCase()) fail("post-deploy owner mismatch");
  if (storedTreasury.toLowerCase() !== treasury.toLowerCase()) fail("post-deploy treasury mismatch");
  if (!initialized) fail("post-deploy initialized flag is false");

  const record = {
    contract: artifact.contractName,
    address,
    chainId: Number(network.chainId),
    chainName: CFG.SEPOLIA_CHAIN_NAME,
    network: "sepolia",
    deployer: wallet.address,
    treasury: storedTreasury,
    owner: storedOwner,
    txHash: deployTx.hash,
    blockNumber: deployReceipt.blockNumber,
    initializeTxHash: initTx.hash,
    initializeBlockNumber: initReceipt.blockNumber,
    deployedAt: new Date().toISOString(),
    compiler: artifact.compiler,
    sourceHash: artifact.sourceHash,
    explorer: `${CFG.SEPOLIA_EXPLORER}/address/${address}`,
    abi: artifact.abi,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n", "utf8");

  console.log("\nDeployment complete");
  console.log("===================");
  console.log(`  contract  : ${address}`);
  console.log(`  etherscan : ${record.explorer}`);
  console.log(`  loanCount : ${loanCount.toString()}`);
  console.log(`  written   : ${path.relative(ROOT, outPath)}`);
  console.log("\nNext steps:");
  console.log("  1. copy the address into frontend/js/config.js (contractAddress + chainId 11155111)");
  console.log("  2. copy the artifact into backend/contract_abi.json (backend owns that file)");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("deploy failed:", err && err.shortMessage ? err.shortMessage : err);
    if (err && err.stack && process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main, loadDotEnv };
