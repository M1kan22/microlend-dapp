/**
 * scripts/chain-config.js — shared chain constants for the deployment scripts and the test
 * harness, so the local dev chain and the in-process test chain never drift apart.
 */
"use strict";

/** Deterministic development mnemonic (ganache's well-known default account set). */
const DEFAULT_MNEMONIC =
  "myth like bonus scare over problem client lizard pioneer submit female collect";

module.exports = {
  DEFAULT_MNEMONIC,

  /** In-process chain used by test/run-tests.js (never exposed on a socket). */
  TEST_CHAIN_ID: 1337,

  /** Local development chain (MetaMask-friendly, "Localhost 8545"). */
  LOCAL_CHAIN_ID: 31337,
  LOCAL_HOST: "127.0.0.1",
  LOCAL_PORT: 8545,
  LOCAL_RPC_URL: "http://127.0.0.1:8545",
  LOCAL_CHAIN_NAME: "MicroLend Local",
  LOCAL_CURRENCY_SYMBOL: "ETH",
  LOCAL_ACCOUNT_BALANCE_ETH: 1000,

  /** Sepolia public testnet. */
  SEPOLIA_CHAIN_ID: 11155111,
  SEPOLIA_CHAIN_NAME: "Sepolia",
  SEPOLIA_EXPLORER: "https://sepolia.etherscan.io",
};
