# Lead end-to-end integration verification (live chain + live backend)

This is the Lead's own acceptance run of the **frozen** tree. It is the only check in this repository
that exercises the real stack — a real EVM over HTTP, the real Flask server, real MetaMask-style
signature authentication, and a real on-chain event decoded back out of a transaction receipt.

![e2e](e2e-result.txt)

## What was run

Four processes/services, no mocks:

| Component | How it was started |
|---|---|
| Local EVM | `scripts/integration-seed.js` — ganache over HTTP on `127.0.0.1:8546`, hardfork shanghai, chainId 31337, deterministic mnemonic |
| Smart contract | same script: `MicroLendPool` deployed and `initialize`d, source hash `e26e720a…`, address `0xe78A0F7E598Cc8b0Bb87894B0F60dD2a88d6a8Ab` |
| Seed state | 20 ETH + 5 ETH supplier deposits; loan #1 = 1 ETH @ 800 bps/30 d (ACTIVE); loan #2 = 40 ETH @ 1200 bps/14 d (PENDING) |
| Backend | `CHAIN_MODE=rpc RPC_URL=http://127.0.0.1:8546 MICROLEND_CONTRACT_ADDRESS=0xe78A… PORT=5057 python backend/app.py` |
| Test driver | `.tooling/integration-e2e.js` — 35 assertions over the live HTTP API |

## Reproduce with (no environment overrides needed)

```powershell
# terminal 1 — documented quick start: chain on 127.0.0.1:8545 + deployment.local.json
node scripts/deploy-local.js

# terminal 2 — read the address the record actually holds (it is nonce-dependent), then start Flask
$addr = (Get-Content deployment.local.json -Raw | ConvertFrom-Json).address
$env:CHAIN_MODE="rpc"; $env:RPC_URL="http://127.0.0.1:8545"
$env:MICROLEND_CONTRACT_ADDRESS=$addr; $env:CHAIN_ID="31337"
python backend/app.py                          # http://127.0.0.1:5000

# terminal 3
node scripts/integration-e2e.js
```

The script reads `deployment.local.json` (overridable with `DEPLOYMENT_FILE`), defaults to
`http://127.0.0.1:5000/api` and `http://127.0.0.1:8545` (overridable with `API_BASE` / `RPC_URL`),
reads the pool address from the record instead of assuming it, and **verifies that address really
holds contract code on the live chain** before testing anything else.

## Headline result — 38 assertions, 0 failed, exit 0

Run standalone against the documented quick start (chain on 8545, Flask on 5000, no overrides):

```
RESULT: 38 passed, 0 failed
```

### Verified working end to end

* `GET /health` reports `chainMode=rpc`, `rpcReachable=true` and a live `blockNumber`.
* `GET /config` serves the 102-entry ABI and the deployed address.
* Full MetaMask-style login: `POST /auth/nonce` → `personal_sign` with the chain's own account key →
  `POST /auth/verify` → bearer token → `GET /auth/session`. The signature is recovered by the
  backend's pure-Python secp256k1 `ecrecover`, and the recovered address matches the chain account.
* Indexing a **real** transaction: the backend fetched the receipt, confirmed `status == 1`, matched
  the contract address and the sender, decoded the `LiquidityDeposited` log and persisted it. Read
  back through `GET /transactions?address=…` as
  `type=deposit status=confirmed amountWei=5000000000000000000 block=4`.
* `pool.onChain` mirrors the live contract exactly: liquidity `25e18`, reserved `1e18`, `loanCount 2`.
* `POST /loans/preview` for 2 ETH @ 1200 bps / 30 d returns interest `19726027397260273` wei, protocol
  fee `1972602739726027` wei and net interest to liquidity `17753424657534246` wei — each matching the
  contract's own formula (`principal × rateBps × days / (10 000 × 365)`, 10 % fee on interest).
* The live `minCollateralBps` is read from the chain (`source: "chain"`) and clamped to the immutable
  5 000 floor, which is the cross-layer fix for the divergence found during review.

**Security behaviour verified by negative cases**

* Write without a bearer token → `401`.
* Indexing a transaction sent by a **different** wallet than the authenticated session → `400` with a
  field-level message naming both addresses. This is the anti-spoofing control working.
* Replaying an already-indexed `txHash` → `409 CONFLICT`, refused as a duplicate.
* Unknown transaction hash → `4xx` with the documented error envelope.
* A submitted amount that disagrees with the on-chain receipt → rejected; the message quotes both the
  chain value and the submitted value.
* Malformed amount (`"not-a-number"`) → `400 VALIDATION_ERROR` with a field-level entry.

## One limitation this run exposed (reported, not hidden)

`POST /transactions/sync` derives the expected `sharesMinted` for a `LiquidityDeposited` event as
`sharesMinted == amountEth`. That is true for every deposit **after** the first, but the first ever
deposit permanently parks `DEAD_SHARES = 1` on the contract, so the chain emits
`sharesMinted = amount - 1` (observed: `19999999999999999999` for a 20 ETH deposit). The endpoint
therefore rejects a *bootstrap* deposit even though the transaction is valid:

```
first-ever deposit sync -> HTTP 400 VALIDATION_ERROR
  "the decoded event does not match the submitted payload: sharesMinted the chain emitted
   19999999999999999999, the request said 20000000000000000000"
```

The validation is behaving as designed (it refuses to record anything it cannot reconcile with the
chain), and all later deposits index correctly. The fix is to accept `sharesMinted ∈ {amount, amount-1}`
or to let the caller supply `sharesMinted` explicitly; it is recorded as an open item on the backend
rather than worked around in the test.

**Honest scope note:** this run used a local EVM, not the Sepolia public testnet. No Sepolia
deployment, no Etherscan verification and no browser/MetaMask UI run were possible in this
environment — see `docs/TESTING.md` §10 for the full list of what remains unverified.
