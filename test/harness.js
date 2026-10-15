/**
 * test/harness.js — shared test infrastructure for the MicroLend contract suite.
 *
 * Provides:
 *   - createNode()      in-process ganache (provider mode, hardfork "shanghai", quiet logging)
 *   - createSession()   ethers v6 BrowserProvider + funded signers + deploy/time-travel helpers
 *   - Assertions        tiny assertion library with pass/fail counting, custom-error decoding,
 *                       event-argument checking and a separate money-invariant counter
 *   - compileSolidityFile()  compile an auxiliary test contract (e.g. the reentrancy probe)
 *
 * Everything is real execution: every assertion runs against an actual EVM via ganache.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MODULES_ROOT = path.join(ROOT, ".tooling", "nm", "node_modules");

const ethers = require(path.join(MODULES_ROOT, "ethers"));
const ganache = require(path.join(MODULES_ROOT, "ganache"));
const solc = require(path.join(MODULES_ROOT, "solc"));

const { compileSource } = require(path.join(ROOT, "scripts", "compile.js"));

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_MNEMONIC = "myth like bonus scare over problem client lizard pioneer submit female collect";
const DAY = 86400n;
const BPS = 10000n;
const DEAD_SHARES = 1n;

// ---------------------------------------------------------------------------
// Formatting / comparison helpers
// ---------------------------------------------------------------------------

function isBigNumberLike(v) {
  return typeof v === "bigint" || (v && typeof v === "object" && v._isBigNumber === true);
}

function toBig(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  if (v && typeof v === "object" && typeof v.toString === "function" && v._isBigNumber) return BigInt(v.toString());
  throw new Error("cannot convert to BigInt: " + String(v));
}

function isAddressLike(v) {
  return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
}

function fmt(v) {
  if (typeof v === "bigint") {
    const eth = v > 10n ** 9n ? ` = ${ethers.formatEther(v)} ETH` : "";
    return `${v}${eth}`;
  }
  if (typeof v === "boolean") return String(v);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (isAddressLike(v)) return v;
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v) || (v && typeof v === "object" && typeof v.length === "number" && !v._isBigNumber)) {
    return "[" + Array.from(v).map(fmt).join(", ") + "]";
  }
  if (v && typeof v === "object" && v._isBigNumber) return v.toString();
  try {
    return JSON.stringify(v, (k, val) => (typeof val === "bigint" ? val.toString() : val));
  } catch {
    return String(v);
  }
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return false;
  if (typeof a === "boolean" || typeof b === "boolean") return Boolean(a) === Boolean(b);
  if (isAddressLike(a) && isAddressLike(b)) return a.toLowerCase() === b.toLowerCase();
  const arrayLike = (v) => Array.isArray(v) || (v && typeof v === "object" && typeof v.length === "number" && !v._isBigNumber);
  if (arrayLike(a) && arrayLike(b)) {
    const aa = Array.from(a);
    const bb = Array.from(b);
    if (aa.length !== bb.length) return false;
    return aa.every((x, i) => looseEqual(x, bb[i]));
  }
  if (isBigNumberLike(a) || isBigNumberLike(b)) {
    try {
      return toBig(a) === toBig(b);
    } catch {
      return false;
    }
  }
  if (typeof a === "string" || typeof b === "string") return String(a) === String(b);
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

function oneLine(err) {
  if (!err) return String(err);
  const msg = err.shortMessage || err.message || String(err);
  return String(msg).split("\n")[0].slice(0, 300);
}

/**
 * Walk an ethers/ganache error object (arbitrary nesting, plus its string form) looking for
 * revert return-data that decodes as a custom error from `iface`.
 */
function decodeCustomError(err, iface) {
  // ethers already decoded it for us in some code paths.
  const direct = err?.revert || err?.error?.revert;
  if (direct && direct.name) {
    try {
      const frag = iface ? iface.getError(direct.name) : null;
      return { name: direct.name, args: Array.from(direct.args || []), signature: frag ? frag.format("sighash") : direct.name };
    } catch {
      return { name: direct.name, args: Array.from(direct.args || []), signature: direct.name };
    }
  }

  const hexes = [];
  const seen = new Set();
  const walk = (v, depth) => {
    if (v === null || v === undefined || depth > 6) return;
    if (typeof v === "string") {
      for (const m of v.match(/0x[0-9a-fA-F]*/g) || []) hexes.push(m);
      return;
    }
    if (typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof Error) {
      walk(v.message, depth + 1);
      walk(v.data, depth + 1);
      walk(v.info, depth + 1);
      walk(v.error, depth + 1);
      walk(v.cause, depth + 1);
      walk(v.revert, depth + 1);
      walk(v.receipt, depth + 1);
    }
    for (const key of Object.keys(v)) {
      try {
        walk(v[key], depth + 1);
      } catch {
        /* getters may throw */
      }
    }
  };
  walk(err, 0);

  if (iface) {
    for (const hex of hexes) {
      if (hex.length < 10 || hex.length % 2 !== 0) continue;
      try {
        const parsed = iface.parseError(hex);
        if (parsed) return { name: parsed.name, args: Array.from(parsed.args), signature: parsed.signature, data: hex };
      } catch {
        /* not one of our custom errors */
      }
    }
    // Fallback: ethers may have rendered the name in the message only.
    const text = [err?.shortMessage, err?.message, err?.info?.error?.message, err?.error?.message]
      .filter(Boolean)
      .join(" | ");
    for (const frag of Object.values(iface.errors || {})) {
      if (frag && new RegExp(`\\b${frag.name}\\b`).test(text)) {
        return { name: frag.name, args: [], signature: frag.name, textOnly: true };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Node (ganache) + session (ethers) bootstrap
// ---------------------------------------------------------------------------

/**
 * Spin up an in-process ganache EVM in provider mode.
 * @param {{chainId?:number, accounts?:number, defaultBalance?:number, mnemonic?:string,
 *          hardfork?:string, deterministic?:boolean}} [options]
 */
async function createNode(options = {}) {
  const chainId = options.chainId ?? 1337;
  const raw = ganache.provider({
    logging: { quiet: true },
    chain: {
      hardfork: options.hardfork ?? "shanghai",
      chainId,
      networkId: chainId,
      vmErrorsOnRPCResponse: true,
      allowUnlimitedContractSize: false,
    },
    wallet: {
      // ganache rejects `deterministic` and `mnemonic` together; a fixed mnemonic is already
      // fully deterministic, so we only ever pass the mnemonic.
      mnemonic: options.mnemonic ?? DEFAULT_MNEMONIC,
      totalAccounts: options.accounts ?? 10,
      defaultBalance: options.defaultBalance ?? 10000,
    },
    miner: { blockGasLimit: 30_000_000, instamine: "eager" },
  });

  // Ganache's provider object *is* an EIP-1193 provider.
  //
  // cacheTimeout: -1 disables ethers' 250 ms "perform" cache. Without it, a second identical
  // eth_call / eth_getBalance / eth_getBlockByNumber within 250 ms silently returns the previous
  // result, which would make post-transaction state assertions read stale values.
  const browserProvider = new ethers.BrowserProvider(raw, undefined, { cacheTimeout: -1 });
  const network = await browserProvider.getNetwork();

  let initialAccounts = null;
  if (typeof raw.getInitialAccounts === "function") {
    try {
      initialAccounts = raw.getInitialAccounts();
    } catch {
      initialAccounts = null;
    }
  }

  const accounts = [];
  if (initialAccounts && Object.keys(initialAccounts).length > 0) {
    let i = 0;
    for (const [address, info] of Object.entries(initialAccounts)) {
      accounts.push({
        index: i++,
        address: ethers.getAddress(address),
        privateKey: info.secretKey,
        signer: new ethers.Wallet(info.secretKey, browserProvider),
      });
    }
  } else {
    // Fallback if the node does not expose getInitialAccounts(): re-derive the deterministic
    // accounts. fromPhrase() already returns m/44'/60'/0'/0/0, so a full path is required.
    const total = options.accounts ?? 10;
    for (let i = 0; i < total; i++) {
      const w = ethers.HDNodeWallet.fromPhrase(options.mnemonic ?? DEFAULT_MNEMONIC, "", `m/44'/60'/0'/0/${i}`);
      accounts.push({ index: i, address: w.address, privateKey: w.privateKey, signer: new ethers.Wallet(w.privateKey, browserProvider) });
    }
  }

  return { raw, provider: browserProvider, accounts, chainId: Number(network.chainId) };
}

/**
 * Build the session helpers used by every suite.
 * @param {object} node result of createNode()
 * @param {object} [options] { artifact } contract artifact {abi, bytecode}
 */
function createSession(node, options = {}) {
  const { raw, provider, accounts } = node;
  const artifact = options.artifact || null;
  let boundAssertions = null;

  const session = {
    ethers,
    ganache,
    solc,
    raw,
    provider,
    accounts,
    artifact,

    /** Bind this session to an Assertions instance so deploy() can register the pool interface. */
    bind(t) {
      boundAssertions = t;
    },

    signer(i = 0) {
      return accounts[i].signer;
    },
    addressOf(i = 0) {
      return accounts[i].address;
    },

    /** Deploy MicroLendPool; `initialize` (default true) calls initialize(treasury, owner). */
    async deploy({ initialize = true, treasury = ZERO_ADDRESS, owner = ZERO_ADDRESS, deployer = 0 } = {}) {
      if (!artifact) throw new Error("session.deploy: no artifact provided");
      const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, accounts[deployer].signer);
      const contract = await factory.deploy();
      await contract.waitForDeployment();
      if (initialize) {
        await (await contract.initialize(treasury, owner)).wait();
      }
      if (boundAssertions) boundAssertions.iface = contract.interface;
      return contract;
    },

    /** Fresh (uncached) ETH balance in wei. */
    async balance(address) {
      const hex = await provider.send("eth_getBalance", [address, "latest"]);
      return BigInt(hex);
    },

    /** Fresh (uncached) latest-block timestamp in unix seconds. */
    async now() {
      const block = await provider.send("eth_getBlockByNumber", ["latest", false]);
      return BigInt(parseInt(block.timestamp, 16));
    },

    /** Fresh (uncached) latest block number. */
    async blockNumber() {
      return BigInt(parseInt(await provider.send("eth_blockNumber", []), 16));
    },

    /** Await a transaction promise and its receipt. */
    async send(txPromise) {
      const tx = await txPromise;
      return tx.wait();
    },

    async now() {
      const block = await provider.getBlock("latest");
      return BigInt(block.timestamp);
    },

    /** Mine at least `secs` more seconds: evm_increaseTime + evm_mine. */
    async increaseTime(secs) {
      const n = Number(secs);
      if (!Number.isFinite(n) || n < 0) throw new Error("increaseTime: bad delta " + secs);
      await provider.send("evm_increaseTime", [n]);
      await provider.send("evm_mine", []);
      return session.now();
    },

    /**
     * Advance the chain clock until `target` (unix seconds) using evm_increaseTime + evm_mine.
     * Returns the resulting timestamp. ganache derives block times from the wall clock plus an
     * offset, so a mine can overshoot by a second; with `exact: true` the clock is pinned with
     * evm_setTime instead so boundary assertions can rely on equality.
     */
    async advanceTo(target, { exact = false } = {}) {
      const want = toBig(target);
      for (let attempt = 0; attempt < 6; attempt++) {
        const current = await session.now();
        if (current === want) return current;
        if (current > want) {
          if (!exact) return current; // already past the target; callers use the real clock
          break;
        }
        const after = await session.increaseTime(want - current);
        if (after === want) return after;
        if (after > want) {
          if (!exact) return after;
          break;
        }
      }
      if (exact) {
        // Pin the clock (ms) and mine a block: the next block lands exactly on `want`.
        await provider.send("evm_setTime", [Number(want) * 1000]);
        await provider.send("evm_mine", []);
      }
      return session.now();
    },

    async snapshot() {
      return provider.send("evm_snapshot", []);
    },
    async revert(snapshotId) {
      return provider.send("evm_revert", [snapshotId]);
    },

    /** eth_call that never throws: { ok, value } | { ok:false, err }. */
    async callRaw(tx) {
      try {
        return { ok: true, value: await provider.call(tx) };
      } catch (err) {
        return { ok: false, err };
      }
    },

    /** Deploy an auxiliary test contract compiled on the fly from a .sol file under test/. */
    async deployAux(relativeSolPath, contractName, args = [], { deployer = 0 } = {}) {
      const abs = path.isAbsolute(relativeSolPath) ? relativeSolPath : path.join(ROOT, relativeSolPath);
      const source = fs.readFileSync(abs, "utf8");
      const key = path.basename(abs);
      const { contract } = compileSource(source, contractName, key);
      const factory = new ethers.ContractFactory(contract.abi, "0x" + contract.evm.bytecode.object, accounts[deployer].signer);
      const deployed = await factory.deploy(...args);
      await deployed.waitForDeployment();
      return deployed;
    },

    ZERO_ADDRESS,
    DAY,
    BPS,
    DEAD_SHARES,
    mnemonic: options.mnemonic ?? DEFAULT_MNEMONIC,
  };
  return session;
}

/** Compile a standalone .sol file (used for auxiliary test contracts). */
function compileSolidityFile(absPath, contractName) {
  const source = fs.readFileSync(absPath, "utf8");
  return compileSource(source, contractName, path.basename(absPath));
}

// ---------------------------------------------------------------------------
// Assertion library
// ---------------------------------------------------------------------------

class Assertions {
  constructor({ verbose = true } = {}) {
    this.records = [];      // { suite, kind, name, ok, detail }
    this.currentSuite = "(none)";
    this.iface = null;
    this.verbose = verbose;
    this._counters = { assertions: 0, invariants: 0 };
  }

  suite(name) {
    this.currentSuite = name;
    if (this.verbose) console.log(`\n== ${name} ==`);
  }

  get total() {
    return this.records.length;
  }
  get passed() {
    return this.records.filter((r) => r.ok).length;
  }
  get failed() {
    return this.total - this.passed;
  }
  get invariantChecks() {
    return this.records.filter((r) => r.kind === "invariant").length;
  }

  _record(kind, ok, name, detail) {
    const rec = { suite: this.currentSuite, kind, name, ok: !!ok };
    if (!ok) rec.detail = detail || "assertion failed";
    this.records.push(rec);
    if (this.verbose) {
      if (!ok) console.log(`   FAIL  ${name}\n         ${rec.detail}`);
    }
    return !!ok;
  }

  ok(cond, name) {
    return this._record("assert", !!cond, name, "expected a truthy value");
  }

  /** Truthiness with an explicit failure detail. */
  check(cond, name, detail) {
    return this._record("assert", !!cond, name, detail || "expected a truthy value");
  }

  fail(name, detail) {
    return this._record("assert", false, name, detail);
  }

  eq(actual, expected, name) {
    const good = looseEqual(actual, expected);
    return this._record("assert", good, name, good ? "" : `expected ${fmt(expected)} — received ${fmt(actual)}`);
  }

  ne(actual, expected, name) {
    const good = !looseEqual(actual, expected);
    return this._record("assert", good, name, good ? "" : `expected a value different from ${fmt(expected)}`);
  }

  wei(actual, expected, name) {
    let good = false;
    let detail = "";
    try {
      const a = toBig(actual);
      const e = toBig(expected);
      good = a === e;
      if (!good) {
        const diff = a > e ? a - e : e - a;
        detail = `expected exactly ${e} wei — received ${a} wei (delta ${a > e ? "+" : "-"}${diff} wei)`;
      }
    } catch (err) {
      detail = "wei comparison failed: " + err.message;
    }
    return this._record("assert", good, name, detail);
  }

  gt(actual, floor, name) {
    let good = false;
    try {
      good = toBig(actual) > toBig(floor);
    } catch {
      good = false;
    }
    return this._record("assert", good, name, `expected > ${fmt(floor)} — received ${fmt(actual)}`);
  }

  gte(actual, floor, name) {
    let good = false;
    try {
      good = toBig(actual) >= toBig(floor);
    } catch {
      good = false;
    }
    return this._record("assert", good, name, `expected >= ${fmt(floor)} — received ${fmt(actual)}`);
  }

  lte(actual, ceiling, name) {
    let good = false;
    try {
      good = toBig(actual) <= toBig(ceiling);
    } catch {
      good = false;
    }
    return this._record("assert", good, name, `expected <= ${fmt(ceiling)} — received ${fmt(actual)}`);
  }

  lt(actual, ceiling, name) {
    let good = false;
    try {
      good = toBig(actual) < toBig(ceiling);
    } catch {
      good = false;
    }
    return this._record("assert", good, name, `expected < ${fmt(ceiling)} — received ${fmt(actual)}`);
  }

  includes(haystack, needle, name) {
    const arr = Array.from(haystack || []);
    const good = arr.some((x) => looseEqual(x, needle));
    return this._record("assert", good, name, `expected ${fmt(haystack)} to include ${fmt(needle)}`);
  }

  /** Money invariant (spec 2.7 rule 12 family) — counted separately from ordinary assertions. */
  invariant(ok, name, detail) {
    return this._record("invariant", !!ok, name, detail);
  }

  /**
   * Assert that an eth_call (typically `contract.fn.staticCall(...)`) reverts with a specific
   * custom error and argument list.
   */
  async reverts(thunk, errorName, expectedArgs = [], name = "(unnamed revert check)", ifaceOverride = null) {
    let ok = true;
    let value;
    let err;
    try {
      value = await thunk();
    } catch (e) {
      ok = false;
      err = e;
    }
    if (ok) {
      return this._record("assert", false, name, `expected revert ${errorName}() but the call succeeded (returned ${fmt(value)})`);
    }
    const iface = ifaceOverride || this.iface;
    const parsed = decodeCustomError(err, iface);
    if (!parsed) {
      return this._record("assert", false, name, `expected revert ${errorName}() but no custom error could be decoded — node said: ${oneLine(err)}`);
    }
    if (parsed.name !== errorName) {
      return this._record(
        "assert",
        false,
        name,
        `expected revert ${errorName}() but received ${parsed.name}(${parsed.args.map(fmt).join(", ")})`
      );
    }
    if (expectedArgs && expectedArgs.length) {
      if (parsed.args.length < expectedArgs.length) {
        return this._record("assert", false, name, `${parsed.name} decoded without arguments (text-only match)`);
      }
      for (let i = 0; i < expectedArgs.length; i++) {
        if (expectedArgs[i] === undefined) continue;
        if (!looseEqual(parsed.args[i], expectedArgs[i])) {
          return this._record(
            "assert",
            false,
            name,
            `${parsed.name} argument #${i}: expected ${fmt(expectedArgs[i])} — received ${fmt(parsed.args[i])}`
          );
        }
      }
    }
    return this._record("assert", true, name);
  }

  /** Assert exactly one log of `eventName` and that the selected arguments match. */
  event(receipt, contract, eventName, expectedArgs = [], name = "(unnamed event check)") {
    const iface = contract.interface;
    const fragment = iface.getEvent(eventName);
    if (!fragment) return this._record("assert", false, name, `ABI has no event ${eventName}`);
    const topic = fragment.topicHash;
    const address = String(contract.target).toLowerCase();
    const logs = (receipt.logs || []).filter(
      (l) => String(l.address).toLowerCase() === address && l.topics[0] === topic
    );
    if (logs.length !== 1) {
      return this._record("assert", false, name, `expected exactly 1 ${eventName} log — found ${logs.length}`);
    }
    let parsed;
    try {
      parsed = iface.parseLog(logs[0]);
    } catch (err) {
      return this._record("assert", false, name, `could not decode ${eventName}: ${err.message}`);
    }
    for (let i = 0; i < expectedArgs.length; i++) {
      if (expectedArgs[i] === undefined) continue;
      const inputName = fragment.inputs[i] ? fragment.inputs[i].name : `#${i}`;
      if (!looseEqual(parsed.args[i], expectedArgs[i])) {
        return this._record(
          "assert",
          false,
          name,
          `${eventName}.${inputName}: expected ${fmt(expectedArgs[i])} — received ${fmt(parsed.args[i])}`
        );
      }
    }
    return this._record("assert", true, name);
  }

  /** Fail if any log of `eventName` exists. */
  noEvent(receipt, contract, eventName, name = "(unnamed negative event check)") {
    const topic = contract.interface.getEvent(eventName).topicHash;
    const logs = (receipt.logs || []).filter(
      (l) => String(l.address).toLowerCase() === String(contract.target).toLowerCase() && l.topics[0] === topic
    );
    return this._record("assert", logs.length === 0, name, `expected no ${eventName} log — found ${logs.length}`);
  }

  /** Convenience: send a transaction and return its receipt. */
  async send(txPromise) {
    const tx = await txPromise;
    return tx.wait();
  }
}

// ---------------------------------------------------------------------------
// Money invariant helper (spec 2.7 rule 12)
// ---------------------------------------------------------------------------

/**
 * Canonical money identity for MicroLendPool:
 *   contractBalance == (totalLiquidity - reservedLiquidity) + accumulatedCollateral + treasuryBalance
 * i.e. free liquidity + collateral held + unclaimed fees. `reservedLiquidity` is inside
 * `totalLiquidity` but has already been disbursed to borrowers, so it is *not* in the contract.
 *
 * The literal rule-12 formula (which adds DEAD_SHARES and omits -reservedLiquidity) is checked
 * separately by the invariants suite so the deviation is documented with exact wei evidence.
 */
async function moneyInvariant(t, pool, label, ctx = null) {
  const [balance, stats, liabilities] = await Promise.all([
    ctx ? ctx.balance(pool.target) : pool.runner.provider.getBalance(pool.target),
    pool.poolStats(),
    pool.liabilities(),
  ]);
  const totalLiquidity = BigInt(stats[1]);
  const available = BigInt(stats[2]);
  const reserved = BigInt(stats[3]);
  const collateral = BigInt(liabilities[1]);
  const fees = BigInt(liabilities[2]);
  const expected = available + collateral + fees;
  const ok = BigInt(balance) === expected;
  return {
    ok,
    balance: BigInt(balance),
    expected,
    totalLiquidity,
    available,
    reserved,
    collateral,
    fees,
  };
}

/** Assert the canonical identity and return the snapshot for further equality checks. */
async function assertMoneyInvariant(t, pool, label, ctx = null) {
  const r = await moneyInvariant(t, pool, label, ctx);
  t.invariant(
    r.ok,
    `${label}: balance == free liquidity + collateral + fees`,
    `contract balance ${r.balance} wei != free ${r.available} + collateral ${r.collateral} + fees ${r.fees} = ${r.expected} wei (delta ${r.balance - r.expected} wei; totalLiquidity=${r.totalLiquidity} reservedLiquidity=${r.reserved})`
  );
  return r;
}

module.exports = {
  ROOT,
  MODULES_ROOT,
  ethers,
  ganache,
  solc,
  ZERO_ADDRESS,
  DEFAULT_MNEMONIC,
  DAY,
  BPS,
  DEAD_SHARES,
  fmt,
  looseEqual,
  toBig,
  oneLine,
  decodeCustomError,
  createNode,
  createSession,
  compileSolidityFile,
  Assertions,
  moneyInvariant,
  assertMoneyInvariant,
};
