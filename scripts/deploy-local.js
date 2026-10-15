#!/usr/bin/env node
/**
 * scripts/deploy-local.js — one-command local stack for demos, screenshots and the frontend.
 *
 *  1. attaches to the chain at LOCAL_RPC_URL (default http://127.0.0.1:8545) if one is already
 *     listening, otherwise starts its own ganache server (chainId 31337, deterministic mnemonic);
 *  2. compiles and deploys MicroLendPool, then calls initialize(treasury, owner) immediately;
 *  3. pre-seeds live data: two supplier deposits, one instantly funded loan and one pending
 *     loan request (skip with --bare);
 *  4. writes deployment.local.json and prints the contract address, the seeded state and the
 *     funded accounts WITH their private keys (local chain only).
 *
 * The generated record contains the deterministic ganache development keys. Those keys have no
 * value and exist only on the local chain, but the file is still key material: it is listed in
 * `.gitignore` and excluded by `scripts/package.ps1`, and the script marks it as local-only.
 * Set LOCAL_DEPLOYMENT_OUT=<path> to write it outside the repository tree instead.
 *
 * Generated record schema (deliberately richer than the E2E fixture — see the note below):
 *   { contract, address, chainId, chainName, network, rpcUrl, explorer, deployer, treasury,
 *     owner, txHash, blockNumber, initializeTxHash, deployedAt, compiler, sourceHash, mnemonic,
 *     accounts: [{ index, address, privateKey }],
 *     warning,                          // local-only key warning
 *     addressNote,                      // why `address` is a per-run value
 *     seeded: {
 *       deposits: [{ account, eth, valueWei, label, sharesWei, txHash }],
 *       loans:    [{ id, borrower, principalWei, rateBps, durationDays, collateralWei, status, txHash }]
 *     },
 *     poolStats: { totalShares, totalLiquidityWei, totalLiquidityEth, availableLiquidityWei,
 *                  reservedLiquidityWei, loanCount, sharePriceWei, paused },
 *     abi }
 * `address` is the CREATE address of the deployer's nonce, so it is NONCE-DEPENDENT on the chain's
 * transaction history: a fresh chain yields 0xe78A0F7E598Cc8b0Bb87894B0F60dD2a88d6a8Ab while a
 * reused chain yields something else (observed 0x254dffcd3277C0b1660F6d42EFbB754edaBAbC2B). Always
 * read `address` from this record after each run; never hard-code it in docs, the UI or the backend.
 * Consumers must read `seeded.deposits[i].txHash`; the Lead's `scripts/integration-e2e.js`
 * reads its own fixture `.tooling/integration-deployment.json`, where `seeded.deposits` is an
 * array of bare hash strings. The two artefacts intentionally differ in shape, so map `.txHash`
 * explicitly if this file is ever used to regenerate that fixture.
 *
 * When this script starts the chain itself it keeps serving until Ctrl+C so the dApp stays live.
 * Pass --exit to deploy, print and quit (useful in CI); an attached chain never blocks.
 * Pass --no-attach to fail fast instead of deploying into a chain that is already listening —
 * use it when another run (or another person) owns that chain and you want a clean fresh-chain
 * address rather than one derived from that chain's history.
 *
 * Usage:
 *   node scripts/deploy-local.js              # deploy + seed + keep the chain alive
 *   node scripts/deploy-local.js --bare       # only deploy + initialize
 *   node scripts/deploy-local.js --exit       # deploy + seed, then exit
 *   node scripts/deploy-local.js --no-attach  # refuse to reuse an already-listening chain
 *   LOCAL_PORT=8546 LOCAL_RPC_URL=http://127.0.0.1:8546 node scripts/deploy-local.js --exit
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MODULES_ROOT = path.join(ROOT, ".tooling", "nm", "node_modules");
const { ethers } = require(path.join(MODULES_ROOT, "ethers"));
const { compileToArtifact } = require(path.join(__dirname, "compile.js"));
const CFG = require(path.join(__dirname, "chain-config.js"));
const { startChain, probe, printAccounts } = require(path.join(__dirname, "dev-chain.js"));

// Default: repository root (the documented quick-start path). LOCAL_DEPLOYMENT_OUT lets the
// key-bearing record be written outside the repository tree entirely.
const OUT_FILE = process.env.LOCAL_DEPLOYMENT_OUT
  ? path.resolve(ROOT, process.env.LOCAL_DEPLOYMENT_OUT)
  : path.join(ROOT, "deployment.local.json");
const D = 10n ** 18n;

async function main() {
  const args = new Set(process.argv.slice(2));
  const bare = args.has("--bare");
  const forceExit = args.has("--exit");
  const noAttach = args.has("--no-attach");
  const port = Number(process.env.LOCAL_PORT || CFG.LOCAL_PORT);
  const rpcUrl = process.env.LOCAL_RPC_URL || `http://${CFG.LOCAL_HOST}:${port}`;

  console.log("MicroLend — local deployment");
  console.log("============================");

  // ---- 1. chain ----
  //
  // NOTE: cacheTimeout -1 disables ethers' 250 ms "perform" cache. Without it a second
  // eth_getTransactionCount within 250 ms of the previous one reuses the cached value, so the
  // next transaction from the same account is sent with an already-used nonce and the node
  // rejects it with "the tx doesn't have the correct nonce". Deployment + initialize + seeding
  // all happen back-to-back from account 0, which is exactly that pattern.
  const providerOptions = { cacheTimeout: -1 };
  let chain = null;
  let accounts;
  const existingChainId = await probe(rpcUrl);
  if (existingChainId !== null) {
    if (noAttach) {
      console.error(`deploy-local: a chain is already listening on ${rpcUrl} (chainId ${existingChainId}) and --no-attach was requested.`);
      console.error("              Refusing to deploy into it: the contract address would depend on that chain's history.");
      console.error("              Stop that chain, or point this run at a free port, e.g.");
      console.error("                LOCAL_PORT=8546 LOCAL_RPC_URL=http://127.0.0.1:8546 node scripts/deploy-local.js --exit");
      process.exit(1);
    }
    console.log(`attaching to the chain already listening on ${rpcUrl} (chainId ${existingChainId})`);
    console.log("           note: the contract address is nonce-dependent on THIS chain's history, so it");
    console.log("                 will differ from a fresh-chain run — always read 'address' from the record.");
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, providerOptions);
    // Recreate the deterministic account list locally: the dev chain uses the fixed mnemonic.
    // NOTE: HDNodeWallet.fromPhrase() already returns the m/44'/60'/0'/0/0 node, so each account
    // must be derived with an explicit full path.
    accounts = [];
    for (let i = 0; i < 10; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(CFG.DEFAULT_MNEMONIC, "", `m/44'/60'/0'/0/${i}`);
      accounts.push({ address: w.address, privateKey: w.privateKey, signer: new ethers.Wallet(w.privateKey, provider) });
    }
    chain = { provider, chainId: existingChainId, rpcUrl, started: false, accounts: accounts.map((a) => ({ address: a.address, privateKey: a.privateKey, balance: 0n })) };
  } else {
    console.log(`no chain on ${rpcUrl}; starting one (chainId ${CFG.LOCAL_CHAIN_ID})`);
    chain = await startChain({ port });
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, providerOptions);
    accounts = chain.accounts.map((a) => ({ ...a, signer: new ethers.Wallet(a.privateKey, provider) }));
    chain = { ...chain, provider, started: true };
  }

  const network = await chain.provider.getNetwork();
  console.log(`chainId   : ${network.chainId}`);

  // ---- 2. compile + deploy + initialize ----
  //
  // The deployment address is tracked here so that a failure during initialisation or seeding
  // still reports the contract that was deployed (and does not write deployment.local.json).
  let address = null;
  let contract = null;
  let deployTx = null;
  let deployReceipt = null;
  let initTx = null;
  let artifact = null;
  let treasury = null;
  let owner = null;
  const seeded = { deposits: [], loans: [] };
  let stats = null;

  try {
    ({ artifact } = compileToArtifact({ write: true }));
    console.log(`compiled  : ${artifact.contractName} solc ${artifact.compiler.version}, sourceHash ${artifact.sourceHash}`);
    console.log(`deployer  : ${accounts[0].address}`);

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, accounts[0].signer);
    contract = await factory.deploy();
    deployTx = contract.deploymentTransaction();
    deployReceipt = await deployTx.wait();
    address = await contract.getAddress();
    console.log(`deployed  : ${address} (block ${deployReceipt.blockNumber})`);
    console.log("           note: the address is per-run (deployer nonce), so read it from the record, not from docs.");

    treasury = process.env.TREASURY_ADDRESS || accounts[0].address;
    owner = process.env.OWNER_ADDRESS || accounts[0].address;
    initTx = await contract.initialize(treasury, owner);
    await initTx.wait();
    console.log(`initialize: treasury ${treasury} / owner ${owner}`);

    // ---- 3. seed live data ----
    if (!bare) {
      const minDeposit = await contract.minDeposit();
      const minLoanPrincipal = await contract.minLoanPrincipal();
      console.log(`limits    : minDeposit ${minDeposit} wei, minLoanPrincipal ${minLoanPrincipal} wei`);

      const seedDeposit = async (idx, eth, label) => {
        const value = ethers.parseEther(String(eth));
        if (value < minDeposit) {
          throw new Error(`seed deposit ${eth} ETH (${value} wei) is below the on-chain minDeposit (${minDeposit} wei)`);
        }
        const receipt = await (await contract.connect(accounts[idx].signer).deposit({ value })).wait();
        const shares = await contract.sharesOf(accounts[idx].address);
        seeded.deposits.push({ account: accounts[idx].address, eth, valueWei: value.toString(), label, sharesWei: shares.toString(), txHash: receipt.hash });
        console.log(`  deposit   : ${eth} ETH (${value} wei) from account ${idx} -> ${shares} shares (${label})`);
      };
      await seedDeposit(0, 20, "primary supplier");
      await seedDeposit(1, 5, "secondary supplier");

      const seedLoan = async (id, idx, principalEth, rateBps, durationDays, collateralEth, expectedStatus, label) => {
        const principal = ethers.parseEther(String(principalEth));
        const collateral = ethers.parseEther(String(collateralEth));
        if (principal < minLoanPrincipal) {
          throw new Error(`seed loan ${id} principal ${principal} wei is below minLoanPrincipal (${minLoanPrincipal} wei)`);
        }
        const required = (principal * (await contract.minCollateralBps()) + 9999n) / 10000n;
        if (collateral < required) {
          throw new Error(`seed loan ${id} collateral ${collateral} wei is below the required ${required} wei`);
        }
        const receipt = await (
          await contract.connect(accounts[idx].signer).requestLoan(principal, BigInt(rateBps), BigInt(durationDays), { value: collateral })
        ).wait();
        const loan = await contract.getLoan(BigInt(id));
        const status = Number(loan.status);
        if (status !== expectedStatus) {
          throw new Error(`seed loan ${id} ended in status ${status}, expected ${expectedStatus}`);
        }
        seeded.loans.push({
          id,
          borrower: accounts[idx].address,
          principalWei: loan.principal.toString(),
          rateBps: loan.rateBps.toString(),
          durationDays: loan.durationDays.toString(),
          collateralWei: loan.collateral.toString(),
          status,
          txHash: receipt.hash,
        });
        console.log(`  loan #${id}   : ${principalEth} ETH @ ${rateBps} bps / ${durationDays} d, ${collateralEth} ETH collateral -> ${label}`);
      };
      // loan #1 activates instantly (1 ETH of the 25 ETH free liquidity), loan #2 stays Pending
      // because 40 ETH exceeds the remaining free liquidity — that is intentional demo data.
      await seedLoan(1, 2, 1, 800, 30, 1, 2, "ACTIVE");
      await seedLoan(2, 3, 40, 1200, 14, 40, 1, "PENDING");
    }

    stats = await contract.poolStats();
  } catch (err) {
    console.error("");
    console.error(`deploy-local FAILED${address ? ` (contract is deployed at ${address})` : ""}: ${err && err.shortMessage ? err.shortMessage : err && err.message ? err.message : err}`);
    if (err && err.info) {
      try {
        console.error("  rpc error: " + JSON.stringify(err.info.error ? { code: err.info.error.code, message: err.info.error.message } : err.info));
      } catch {
        /* ignore */
      }
    }
    if (process.env.DEBUG && err && err.stack) console.error(err.stack);
    console.error("deployment.local.json was NOT written.");
    process.exit(1);
  }

  // ---- 4. report ----
  const summary = {
    totalShares: stats[0].toString(),
    totalLiquidityWei: stats[1].toString(),
    totalLiquidityEth: ethers.formatEther(stats[1]),
    availableLiquidityWei: stats[2].toString(),
    reservedLiquidityWei: stats[3].toString(),
    loanCount: stats[9].toString(),
    sharePriceWei: stats[10].toString(),
    paused: stats[11],
  };

  const record = {
    contract: artifact.contractName,
    address,
    chainId: Number(network.chainId),
    chainName: CFG.LOCAL_CHAIN_NAME,
    network: "localhost",
    rpcUrl: chain.rpcUrl,
    explorer: null,
    deployer: accounts[0].address,
    treasury,
    owner,
    txHash: deployTx.hash,
    blockNumber: deployReceipt.blockNumber,
    initializeTxHash: initTx.hash,
    deployedAt: new Date().toISOString(),
    compiler: artifact.compiler,
    sourceHash: artifact.sourceHash,
    mnemonic: CFG.DEFAULT_MNEMONIC,
    accounts: accounts.map((a, i) => ({ index: i, address: a.address, privateKey: a.privateKey })),
    warning:
      "LOCAL DEVELOPMENT ONLY. These are the deterministic ganache keys (no value). Never fund or " +
      "reuse them on a public network. This file is listed in .gitignore and excluded by scripts/package.ps1.",
    addressNote:
      "The contract address is per-run: it is the CREATE address of the deployer's nonce on this chain, " +
      "so it changes with the chain's prior transaction history. A fresh chain yields " +
      "0xe78A0F7E598Cc8b0Bb87894B0F60dD2a88d6a8Ab; a reused chain yields something else. Always read " +
      "`address` from this record after each run instead of hard-coding it.",
    seeded,
    poolStats: summary,
    abi: artifact.abi,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 2) + "\n", "utf8");

  console.log("");
  console.log("Seeded pool state");
  console.log("-----------------");
  console.log(`  totalLiquidity     : ${summary.totalLiquidityEth} ETH`);
  console.log(`  availableLiquidity : ${ethers.formatEther(summary.availableLiquidityWei)} ETH`);
  console.log(`  reservedLiquidity  : ${ethers.formatEther(summary.reservedLiquidityWei)} ETH`);
  console.log(`  loans              : ${summary.loanCount}`);
  console.log(`  paused             : ${summary.paused}`);
  console.log("");
  console.log("Accounts (LOCAL CHAIN ONLY)");
  console.log("---------------------------");
  printAccounts(chain.accounts, Number(network.chainId), chain.rpcUrl);
  console.log("");
  console.log("Frontend wiring (frontend/js/config.js — frontend owns that file):");
  console.log(`  chainId: ${Number(network.chainId)}, chainName: "${CFG.LOCAL_CHAIN_NAME}", contractAddress: "${address}"`);
  console.log("");
  console.log(`written: ${path.relative(ROOT, OUT_FILE)}`);
  console.log("note   : this record contains the deterministic LOCAL development private keys (no value).");
  console.log("         It is listed in .gitignore and excluded by scripts/package.ps1; never reuse these keys on a public chain.");

  if (chain.started && !forceExit) {
    console.log("");
    console.log("Local chain is live with seeded data. Ctrl+C to stop.");
    const shutdown = () => {
      console.log("\nstopping local chain...");
      try {
        const maybe = chain.server.close(() => process.exit(0));
        if (maybe && typeof maybe.then === "function") maybe.then(() => process.exit(0)).catch(() => process.exit(0));
      } catch {
        process.exit(0);
      }
      setTimeout(() => process.exit(0), 1500);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("deploy-local failed:", err && err.shortMessage ? err.shortMessage : err);
    if (err && err.stack && process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { main };
