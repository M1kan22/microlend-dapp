#!/usr/bin/env node
/**
 * scripts/integration-e2e.js — end-to-end integration test against a LIVE local chain.
 *
 * Exercises the frozen REST surface in CHAIN_MODE=rpc:
 *   nonce -> personal_sign -> bearer token -> index a real deposit tx -> read it back.
 * Proves auth, receipt verification, event decoding and persistence all work together.
 *
 * Prerequisites (the documented quick start, in two other terminals):
 *   node scripts/deploy-local.js                  # chain on 127.0.0.1:8545 + deployment.local.json
 *   python backend/app.py                         # CHAIN_MODE=rpc, 127.0.0.1:5000
 *
 * Then:  node scripts/integration-e2e.js
 * Overrides: API_BASE, RPC_URL, and DEPLOYMENT_FILE (defaults to the root deployment.local.json).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.resolve(__dirname, "..");
const MR = path.join(ROOT, ".tooling", "nm", "node_modules");
const { ethers } = require(path.join(MR, "ethers"));

const API = process.env.API_BASE || "http://127.0.0.1:5000/api";
const RPC = process.env.RPC_URL || "http://127.0.0.1:8545";

/**
 * Load the deployment record written by `node scripts/deploy-local.js`.
 *
 * The root `deployment.local.json` is the documented quick-start artefact and holds enriched
 * entries ({txHash, valueWei, sharesWei, account}). An older scratch path stored bare hash strings;
 * both shapes are normalised so this script runs against the documented quick start.
 */
function loadDeployment() {
  const candidates = [
    process.env.DEPLOYMENT_FILE,
    path.join(ROOT, "deployment.local.json"),
    path.join(ROOT, ".tooling", "integration-deployment.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const deposits = ((raw.seeded || {}).deposits || [])
      .map((d) => (typeof d === "string" ? { txHash: d } : { txHash: d.txHash, valueWei: d.valueWei, account: d.account }))
      .filter((d) => d.txHash);
    if (deposits.length < 2) continue;
    return { ...raw, deposits, recordPath: path.relative(ROOT, file) };
  }
  throw new Error(
    "no usable deployment record: run `node scripts/deploy-local.js` first (writes deployment.local.json)"
  );
}

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? " :: " + detail : ""}`); }
}

async function req(method, url, { body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

(async () => {
  // If the documented quick-start chain is not running, start one in-process and seed it through
  // the same script, so this suite is self-contained rather than dependent on another terminal.
  const { probe, startChain } = require(path.join(__dirname, "dev-chain.js"));
  if ((await probe(RPC)) === null) {
    const port = Number(new URL(RPC).port || 8545);
    console.log(`no chain on ${RPC}; starting an in-process one on port ${port} and seeding it`);
    await startChain({ port, quiet: true });
    try {
      const { spawnSync } = require("child_process");
      const run = spawnSync(process.execPath, [path.join(__dirname, "deploy-local.js"), "--exit"], {
        cwd: ROOT,
        env: { ...process.env, LOCAL_PORT: String(port), LOCAL_RPC_URL: RPC },
        stdio: "ignore",
      });
      if (run.status !== 0) throw new Error(`deploy-local.js exited ${run.status}`);
    } catch (err) {
      // A sandbox may forbid spawning a piped child; an existing record for this chain is enough.
      console.log(`  note  : could not run deploy-local.js (${err.message}); using the existing record`);
    }
  }

  const deploy = loadDeployment();
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const acct0 = deploy.accounts[0].address;
  console.log(`record: ${deploy.recordPath}   pool: ${deploy.address}   chainId: ${deploy.chainId}`);
  console.log(`api  : ${API}   rpc: ${RPC}`);
  console.log("note : the pool address is nonce-dependent, so it is read from the record, never assumed");
  console.log(`record: ${deploy.recordPath}   pool: ${deploy.address}   chainId: ${deploy.chainId}`);
  console.log(`api  : ${API}   rpc: ${RPC}`);
  console.log("note : the pool address is nonce-dependent, so it is read from the record, never assumed");

  console.log("== 0. the record's contract is really deployed on this chain ==");
  // A hard-coded address would silently test the wrong contract if the chain was restarted or
  // deploy-local attached to an older chain (the address depends on the deployer's nonce).
  const code = await provider.getCode(deploy.address);
  check("the record's address holds contract code on the live chain", code && code !== "0x",
    `eth_getCode(${deploy.address}) returned ${code === "0x" ? "0x (no contract)" : "nothing"}`);
  const onChainDeployer = await provider.getTransaction(deploy.txHash).then((tx) => tx && tx.from).catch(() => null);
  check("the deployment tx in the record exists on this chain", onChainDeployer !== null, String(deploy.txHash));

  console.log("== 1. health / config ==");
  const health = await req("GET", `${API}/health`);
  check("GET /health is 200", health.status === 200, `status ${health.status}`);
  check("health reports chainMode=rpc", health.json?.data?.chainMode === "rpc");
  check("health reports rpcReachable", health.json?.data?.chain?.rpcReachable === true);
  check("health sees blockNumber > 0", (health.json?.data?.chain?.blockNumber || 0) > 0);

  const cfg = await req("GET", `${API}/config`);
  check("GET /config is 200", cfg.status === 200);
  check("config ABI has 102 entries", cfg.json?.data?.abi?.length === 102, `got ${cfg.json?.data?.abi?.length}`);
  const cfgAddress = cfg.json?.data?.contractAddress;
  if (cfgAddress && cfgAddress.toLowerCase() !== deploy.address.toLowerCase()) {
    console.log(`  note  : the running backend is configured for ${cfgAddress}, but ${deploy.recordPath} now`);
    console.log(`          records ${deploy.address} (the address shifts with the deployer's nonce).`);
    console.log("          Restart the backend with MICROLEND_CONTRACT_ADDRESS from the current record.");
  }
  check("the running backend targets the contract in the record",
    cfgAddress?.toLowerCase() === deploy.address.toLowerCase(),
    `backend=${cfgAddress} record=${deploy.address}`);

  console.log("== 2. auth: nonce -> personal_sign -> verify ==");
  const nonceRes = await req("POST", `${API}/auth/nonce`, { body: { address: acct0 } });
  check("POST /auth/nonce is 201", nonceRes.status === 201, `status ${nonceRes.status}`);
  const message = nonceRes.json?.data?.message;
  check("nonce response carries a SIWE-style message", typeof message === "string" && message.includes(acct0));

  // Sign with the chain's deterministic account 0 key (LOCAL CHAIN ONLY).
  const mnemonic = "myth like bonus scare over problem client lizard pioneer submit female collect";
  const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, "", "m/44'/60'/0'/0/0");
  check("derived signer matches the chain's account 0", wallet.address.toLowerCase() === acct0.toLowerCase(),
    `${wallet.address} vs ${acct0}`);
  const signature = await wallet.signMessage(message);

  const verifyRes = await req("POST", `${API}/auth/verify`, { body: { address: acct0, signature } });
  check("POST /auth/verify is 200", verifyRes.status === 200, `status ${verifyRes.status} ${JSON.stringify(verifyRes.json).slice(0, 200)}`);
  const token = verifyRes.json?.data?.token;
  check("verify returns a bearer token", typeof token === "string" && token.length > 20);

  const sess = await req("GET", `${API}/auth/session`, { token });
  check("GET /auth/session authenticates the token", sess.status === 200 && sess.json?.data?.address?.toLowerCase() === acct0.toLowerCase());

  console.log("== 3. index a REAL deposit transaction from the live chain ==");
  const replayed = await req("POST", `${API}/auth/nonce`, { body: { address: acct0 } });
  const signature2 = await wallet.signMessage(replayed.json.data.message);
  const token2 = (await req("POST", `${API}/auth/verify`, { body: { address: acct0, signature: signature2 } })).json.data.token;

  const txHash = deploy.deposits[0].txHash;
  const receipt = await provider.getTransactionReceipt(txHash);
  check("deposit receipt exists on the local chain", receipt !== null && receipt.status === 1);

  // The bootstrap deposit parks DEAD_SHARES, so the chain emits sharesMinted = amount - 1.
  // The backend's LiquidityDeposited expectation is `sharesMinted == amountEth`, so a first-ever
  // deposit cannot be indexed through this endpoint (reported as a finding). For the rest of this
  // run we index the SECOND deposit, which mints exactly its amount.
  const poolAbi = deploy.abi;
  const iface = new ethers.Interface(poolAbi);
  const deposited = [];
  for (const entry of deploy.deposits) {
    const rcpt = await provider.getTransactionReceipt(entry.txHash);
    const value = (await provider.getTransaction(entry.txHash)).value;
    const log = rcpt.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } })
      .find((p) => p && p.name === "LiquidityDeposited");
    deposited.push({ hash: entry.txHash, value, sharesMinted: log ? log.args.sharesMinted : null, amount: log ? log.args.amount : null });
  }
  const bootstrap = deposited[0];
  const second = deposited[1];
  check("bootstrap deposit emits sharesMinted == amount - 1 (dead share parked)",
    bootstrap.sharesMinted === bootstrap.amount - 1n,
    `${bootstrap.sharesMinted} vs ${bootstrap.amount}`);
  check("second deposit emits sharesMinted == amount exactly",
    second.sharesMinted === second.amount, `${second.sharesMinted} vs ${second.amount}`);

  const syncRes = await req("POST", `${API}/transactions/sync`, {
    body: { txHash: second.hash, amountEth: ethers.formatEther(second.amount) },
    token: token2,
  });
  check("sync of a tx by a DIFFERENT wallet is rejected (sender must match the session)",
    syncRes.status === 400 && /does not match the authenticated wallet/.test(syncRes.json?.error?.fields?.txHash || ""),
    `status ${syncRes.status}`);

  // Authenticate as the wallet that actually sent the second deposit.
  const acct1 = deploy.accounts[1].address;
  const wallet1 = ethers.HDNodeWallet.fromPhrase(
    "myth like bonus scare over problem client lizard pioneer submit female collect", "", "m/44'/60'/0'/0/1");
  check("derived second signer matches the chain's account 1", wallet1.address.toLowerCase() === acct1.toLowerCase());
  const n1 = await req("POST", `${API}/auth/nonce`, { body: { address: acct1 } });
  const sig1 = await wallet1.signMessage(n1.json.data.message);
  const token1 = (await req("POST", `${API}/auth/verify`, { body: { address: acct1, signature: sig1 } })).json.data.token;

  const syncOk = await req("POST", `${API}/transactions/sync`, {
    body: { txHash: second.hash, amountEth: ethers.formatEther(second.amount) },
    token: token1,
  });
  // This suite is idempotent: on a second run against the same database the row already exists, so
  // the replay guard answers 409. That is the guard working, and the assertions below then validate
  // the row via the read API instead of via the create response.
  const alreadyIndexed = syncOk.status === 409;
  if (alreadyIndexed) console.log("  note  : this tx was already indexed by an earlier run; validating via GET");
  check("POST /transactions/sync is 200 (or 409 if a previous run already indexed it)",
    syncOk.status === 200 || alreadyIndexed,
    `status ${syncOk.status} ${JSON.stringify(syncOk.json).slice(0, 300)}`);
  const synced = syncOk.json?.data;
  if (!alreadyIndexed) {
    check("sync decoded the LiquidityDeposited event", synced?.type === "deposit" || synced?.eventType === "LiquidityDeposited",
      JSON.stringify(synced).slice(0, 200));
    check("sync recorded the real on-chain amount (5 ETH)",
      String(synced?.amountWei || synced?.amount_wei) === "5000000000000000000",
      String(synced?.amountWei || synced?.amount_wei));
  }

  const replay = await req("POST", `${API}/transactions/sync`, {
    body: { txHash: second.hash, amountEth: ethers.formatEther(second.amount) },
    token: token1,
  });
  check("replaying the same txHash is rejected as a conflict", replay.status === 409 || replay.status === 400,
    `status ${replay.status}`);

  console.log("== 4. read models ==");
  const pool = await req("GET", `${API}/pool`);
  check("GET /pool is 200", pool.status === 200);
  const onChain = pool.json?.data?.onChain;
  check("pool.onChain reflects live liquidity of 25 ETH",
    onChain?.totalLiquidity_Wei === "25000000000000000000", JSON.stringify(onChain || {}).slice(0, 160));
  check("pool.onChain reflects 1 ETH reserved", onChain?.reservedLiquidity_Wei === "1000000000000000000");
  check("pool.onChain reflects loanCount 2", onChain?.loanCount_Wei === "2");

  const txns = await req("GET", `${API}/transactions?address=${acct1}&limit=10`);
  check("GET /transactions is 200", txns.status === 200);
  const indexedItems = txns.json?.data?.items || [];
  check("the indexed deposit is retrievable", (txns.json?.data?.total || 0) >= 1,
    JSON.stringify(txns.json?.data || {}).slice(0, 200));
  const indexedAmount = indexedItems.find((t) => (t.txHash || "").toLowerCase() === second.hash.toLowerCase())?.amountWei;
  check("the indexed row carries the decoded 5 ETH amount", indexedAmount === "5000000000000000000",
    String(indexedAmount ?? "(row not found)"));

  const pos = await req("GET", `${API}/positions/${acct0}`);
  check("GET /positions/<address> is 200", pos.status === 200);

  const loans = await req("GET", `${API}/loans?limit=10`);
  check("GET /loans is 200", loans.status === 200);
  console.log(`  note  : /loans total = ${loans.json?.data?.total} (0 expected: the 2 loans were created directly on-chain, not via the API)`);

  console.log("== 5. negative cases ==");
  const noAuth = await req("POST", `${API}/transactions/sync`, { body: { txHash } });
  check("write without a token is 401", noAuth.status === 401, `status ${noAuth.status}`);

  const badHash = await req("POST", `${API}/transactions/sync`, { body: { txHash: "0x" + "11".repeat(32), amountEth: "1" }, token: token2 });
  check("unknown tx hash is rejected 4xx", badHash.status >= 400 && badHash.status < 500, `status ${badHash.status}`);
  check("unknown tx hash returns the error envelope", badHash.json?.ok === false && !!badHash.json?.error?.code);

  const badAmount = await req("POST", `${API}/transactions/sync`, { body: { txHash: second.hash, amountEth: "not-a-number" }, token: token2 });
  check("malformed amount is a field-level VALIDATION_ERROR",
    badAmount.status === 400 && badAmount.json?.error?.code === "VALIDATION_ERROR",
    `status ${badAmount.status} ${JSON.stringify(badAmount.json).slice(0, 200)}`);

  const mismatch = await req("POST", `${API}/transactions/sync`, { body: { txHash: second.hash, amountEth: "999" }, token: token2 });
  check("amount mismatch against the chain receipt is rejected", mismatch.status >= 400, `status ${mismatch.status}`);

  console.log("== 6. known limitation: bootstrap deposit cannot be indexed ==");
  const bootstrapSync = await req("POST", `${API}/transactions/sync`, {
    body: { txHash: bootstrap.hash, amountEth: ethers.formatEther(bootstrap.amount) },
    token: token2,
  });
  console.log(`  info  : first-ever deposit sync -> HTTP ${bootstrapSync.status} (${bootstrapSync.json?.error?.code || "ok"})`);
  console.log(`  info  : reason -> ${bootstrapSync.json?.error?.message?.slice(0, 160) || "n/a"}`);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error("E2E FAIL:", err.message); process.exit(1); });
