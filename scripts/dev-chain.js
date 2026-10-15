#!/usr/bin/env node
/**
 * scripts/dev-chain.js — a persistent local development chain for the MicroLend DApp.
 *
 * Starts ganache as a real HTTP JSON-RPC server on 127.0.0.1:8545 with chainId 31337 and a
 * deterministic mnemonic, prints the funded accounts (private keys included — LOCAL ONLY) and
 * keeps serving until Ctrl+C. MetaMask can add it as a custom network.
 *
 * This script deploys nothing: run `node scripts/deploy-local.js` afterwards to deploy the
 * contract, or in one step (`deploy-local.js` will start this chain itself if nothing is
 * listening on 8545).
 */
"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MODULES_ROOT = path.join(ROOT, ".tooling", "nm", "node_modules");
const { ethers } = require(path.join(MODULES_ROOT, "ethers"));
const CFG = require(path.join(__dirname, "chain-config.js"));

/**
 * Start a ganache HTTP server.
 * @returns {Promise<{server: object, accounts: {address: string, privateKey: string, balance: bigint}[],
 *                    port: number, chainId: number, rpcUrl: string}>}
 */
async function startChain(options = {}) {
  const ganache = require(path.join(MODULES_ROOT, "ganache"));
  const port = options.port ?? CFG.LOCAL_PORT;
  const host = options.host ?? CFG.LOCAL_HOST;
  const chainId = options.chainId ?? CFG.LOCAL_CHAIN_ID;
  const mnemonic = options.mnemonic ?? CFG.DEFAULT_MNEMONIC;
  const balanceEth = options.balanceEth ?? CFG.LOCAL_ACCOUNT_BALANCE_ETH;

  const server = ganache.server({
    logging: { quiet: options.quiet !== false },
    chain: {
      hardfork: "shanghai",
      chainId,
      networkId: chainId,
      vmErrorsOnRPCResponse: true,
      allowUnlimitedContractSize: false,
    },
    wallet: { mnemonic, totalAccounts: options.accounts ?? 10, defaultBalance: balanceEth },
    miner: { blockGasLimit: 30_000_000, instamine: "eager" },
    server: { port, host },
  });

  await new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve();
    };
    try {
      const maybe = server.listen(port, host, (err) => done(err));
      if (maybe && typeof maybe.then === "function") maybe.then(() => done()).catch(done);
    } catch (err) {
      done(err);
    }
  });

  let accounts = [];
  if (typeof server.provider.getInitialAccounts === "function") {
    accounts = Object.entries(server.provider.getInitialAccounts()).map(([address, info]) => ({
      address: ethers.getAddress(address),
      privateKey: info.secretKey,
      balance: BigInt(info.balance),
    }));
  }

  return { server, accounts, port, host, chainId, rpcUrl: `http://${host}:${port}` };
}

/** True when something already answers eth_chainId at `rpcUrl`. */
async function probe(rpcUrl) {
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    const net = await Promise.race([
      provider.getNetwork(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1500)),
    ]);
    return Number(net.chainId);
  } catch {
    return null;
  }
}

function printAccounts(accounts, chainId, rpcUrl) {
  console.log(`RPC URL   : ${rpcUrl}`);
  console.log(`chainId   : ${chainId}  (MetaMask -> Add network -> RPC URL above)`);
  console.log("");
  console.log("Funded accounts (LOCAL DEVELOPMENT ONLY — never use these keys on a public network)");
  console.log("  #   address                                        balance        private key");
  console.log("  --- ------------------------------------------  ------------  ----------------------------------------------------------------");
  accounts.forEach((a, i) => {
    console.log(
      `  ${String(i).padEnd(3)} ${a.address}  ${ethers.formatEther(a.balance).padStart(10)} ETH  ${a.privateKey}`
    );
  });
}

async function main() {
  const port = Number(process.env.LOCAL_PORT || CFG.LOCAL_PORT);
  const rpcUrl = process.env.LOCAL_RPC_URL || `http://${CFG.LOCAL_HOST}:${port}`;

  const existing = await probe(rpcUrl);
  if (existing !== null) {
    console.log(`A chain is already listening on ${rpcUrl} (chainId ${existing}). Nothing to start.`);
    return;
  }

  const chain = await startChain({ port });
  console.log("MicroLend local development chain");
  console.log("=================================");
  console.log("ganache, hardfork shanghai, deterministic mnemonic");
  console.log("");
  printAccounts(chain.accounts, chain.chainId, chain.rpcUrl);
  console.log("");
  console.log("The chain is live. Deploy the contract with:");
  console.log("  node scripts/deploy-local.js");
  console.log("Then press Ctrl+C here to stop the chain.");

  const shutdown = (signal) => {
    console.log(`\nreceived ${signal}: stopping the local chain...`);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      process.exit(0);
    };
    try {
      const maybe = chain.server.close(finish);
      if (maybe && typeof maybe.then === "function") maybe.then(finish).catch(finish);
    } catch {
      finish();
    }
    setTimeout(finish, 1500);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((err) => {
    console.error("dev-chain failed:", err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { startChain, probe, printAccounts };
