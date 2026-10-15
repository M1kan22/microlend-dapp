# MicroLend backend

Flask REST API + SQLite indexer for the **MicroLend** peer-to-pool micro-lending DApp
(SC6113 Individual Assignment). It implements the frozen surface in
[`docs/INTEGRATION_SPEC.md`](../docs/INTEGRATION_SPEC.md) section 3 and mirrors the on-chain
rules of [`contracts/MicroLendPool.sol`](../contracts/MicroLendPool.sol).

* **JSON only.** Every response is `{"ok": true, "data": …}` or
  `{"ok": false, "error": {"code", "message", "fields"}}`. 404/405/500 are JSON too — never HTML.
* **Offline-first.** `CHAIN_MODE=mock` (the default) makes the whole DApp demonstrable and
  gradable with no testnet, no RPC endpoint and no wallet.
* **No `web3`, no `eth-keys`, no `pycryptodome`.** Keccak-256 (`keccak.py`) and secp256k1
  `personal_sign` recovery (`auth.py`) are vendored in pure Python; chain access is raw
  JSON-RPC over `urllib`.
* **No private key is ever received, logged or stored.** Signing happens in MetaMask.

---

## 1. Quick start

```powershell
# 1. dependencies (skip if you already have Flask/pytest)
python -m pip install -r backend/requirements.txt

# 2. (optional) seed the offline demo data explicitly
python backend/seed.py                # --reset to wipe and re-seed, --check to verify

# 3. run the API on http://127.0.0.1:5000
python backend/app.py
```

`python backend/app.py` seeds the demo data automatically on first start when the loans
table is empty, so `GET /api/pool` and `GET /api/loans` return meaningful data immediately.

```powershell
curl http://127.0.0.1:5000/api/health
curl http://127.0.0.1:5000/api/pool
curl "http://127.0.0.1:5000/api/loans?limit=5"
```

### Tests

```powershell
python -m pytest backend/tests -q
```

**84 test functions / 409 assertions**, covering every route, the envelope and status codes,
auth (required / invalid / expired / revoked / replay), field-level validation errors,
duplicate-transaction conflicts, 404/405/500 JSON handling, pagination, the mock chain,
exact-decimal money handling, and Keccak-256 / `personal_sign` vectors cross-checked against
`ethers.js`. `backend/tests/conftest.py` adds `.tooling/pylibs` (this environment's bundled
dependencies) to `sys.path` **relative to the repo root** and skips it when missing, so a
normal virtualenv needs no configuration.

---

## 2. Layout

| File | Responsibility |
|---|---|
| `app.py` | App factory, all 19 routes, JSON envelope, CORS, per-IP rate limiting, request ids, structured JSON logging, global error handlers |
| `db.py` | SQLite schema + versioned migrations (WAL, `Row` factory), row serialisation, indexed pool snapshot |
| `chain.py` | `CHAIN_MODE=rpc` raw JSON-RPC client and pure-Python ABI decoder; `CHAIN_MODE=mock` deterministic offline chain |
| `validation.py` | Pure money/limit functions: exact decimal ETH ⇄ wei, EIP-55 addresses, contract limits, interest/late-fee/liquidation maths |
| `auth.py` | Nonces, SIWE-style message, pure-Python secp256k1 `ecrecover`, HMAC-signed bearer tokens |
| `keccak.py` | Vendored Keccak-f[1600] / Keccak-256 (Ethereum padding, **not** NIST SHA3) |
| `contract_abi.json` | ABI of the deployed `MicroLendPool`; served to the frontend by `GET /api/config` |
| `demo_seed.py`, `seed.py` | Deterministic offline demo data + CLI |
| `tests/` | pytest suite, runtime-generated test signer, ethers.js signature fixtures |

---

## 3. Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN_MODE` | `mock` | `mock` = offline deterministic demo; `rpc` = verify receipts against a real chain |
| `DATABASE_PATH` | `backend/microlend.db` | SQLite file (`MICROLEND_DB` is accepted as an alias) |
| `MICROLEND_CONTRACT_ADDRESS` | mock placeholder | Deployed pool address; **required** when `CHAIN_MODE=rpc` |
| `RPC_URL` | *(empty)* | JSON-RPC endpoint; **required** when `CHAIN_MODE=rpc` |
| `CHAIN_ID` | `11155111` | Sepolia |
| `CHAIN_NAME` | `Sepolia` | Reported by `GET /api/config` |
| `EXPLORER_BASE` | `https://sepolia.etherscan.io` | Explorer link base |
| `FLASK_SECRET_KEY` / `AUTH_TOKEN_SECRET` | random per process | HMAC key for bearer tokens. Set it in any real deployment, otherwise restarting the server invalidates every session |
| `AUTH_TOKEN_TTL_SECONDS` | `43200` (12 h) | Session lifetime |
| `NONCE_TTL_SECONDS` | `300` | Sign-in nonce lifetime |
| `CORS_ORIGINS` | `*` | Comma-separated allow-list for `/api/*` |
| `RATE_LIMIT_ENABLED` | `true` | Per-IP token bucket |
| `RATE_LIMIT_PER_MINUTE` | `240` | Refill rate |
| `RATE_LIMIT_BURST` | `120` | Bucket size |
| `AUTO_SEED` | `true` | Seed demo data on first start |
| `LOG_LEVEL` | `INFO` | `DEBUG`/`INFO`/`WARNING`/… |
| `HOST`, `PORT` | `127.0.0.1`, `5000` | Bind address |

`DATABASE_PATH`, `CORS_ORIGINS`, `CHAIN_MODE`, `RPC_URL` and `AUTH_TOKEN_TTL_SECONDS` are the
names used in the repo-root [`.env.example`](../.env.example).

---

## 4. Endpoints (base `/api`)

`Auth` = requires `Authorization: Bearer <token>`.

| Method | Path | Auth | Success |
|---|---|---|---|
| GET | `/health` | – | 200 service, chain and DB status |
| GET | `/config` | – | 200 `chainId`, `chainName`, `contractAddress`, `explorerBase`, `apiBase`, `rpcUrl`, `chainMode`, `demoMode`, `abi`/`contractAbi`, `params` |
| POST | `/auth/nonce` | – | 201 `{address, nonce, message, expiresAt}` |
| POST | `/auth/verify` | – | 200 `{token, address, expiresAt}` |
| GET | `/auth/session` | ✔ | 200 `{address, expiresAt}` |
| POST | `/auth/logout` | ✔ | 200 `{loggedOut: true}` |
| GET | `/pool` | – | 200 indexed pool snapshot + contract metadata (+ `onChain` in `rpc` mode) |
| GET | `/loans?status=&borrower=&limit=&offset=` | – | 200 `{items, total, limit, offset}` |
| GET | `/loans/<loan_id>` | – | 200 loan |
| GET | `/loans/<loan_id>/history` | – | 200 `{items: [...]}` |
| POST | `/loans/preview` | – | 200 interest / total due / required collateral / APR |
| POST | `/loans` | ✔ | 201 loan |
| POST | `/loans/<loan_id>/fund` | ✔ | 200 loan |
| POST | `/loans/<loan_id>/repay` | ✔ | 200 loan |
| POST | `/loans/<loan_id>/liquidate` | ✔ | 200 loan |
| GET | `/transactions?address=&type=&status=&limit=&offset=` | – | 200 `{items, total, limit, offset}` |
| POST | `/transactions/sync` | ✔ | 200 transaction |
| GET | `/positions/<address>` | – | 200 position + that wallet's loans |
| POST | `/simulate` | – | 200 `{allowed, errors, warnings, estimate}` |

Error codes: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `AUTH_INVALID`, `NOT_FOUND`, `CONFLICT`,
`UPSTREAM_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR` → HTTP 400/401/401/404/409/502/429/500.

### Money rules

Amounts cross the API as **exact decimal ETH strings**: `"0.05"`, `"1"`, `".5"`.
JSON numbers, floats and scientific notation are **rejected** (`400`, field-level message) —
binary floating point cannot represent `0.1` exactly, so accepting it would corrupt wei.
All arithmetic uses `decimal.Decimal` and integer wei; **no float ever touches a money path**.

### The collateral requirement is read live, never hard-coded

`MicroLendPool.minCollateralBps` is **owner-settable** (initial value `10_000` = 100% of
principal) and its only immutable bound is `MIN_COLLATERAL_FLOOR_BPS = 5_000` (50%). The API
therefore never treats `10_000` as the rule:

| Mode | Where the requirement comes from |
|---|---|
| `rpc` | the public `minCollateralBps()` getter, via `eth_call` |
| `mock` | the indexed value in `pool_state` (default `10_000`) |

Either value is clamped **up** to `5_000`, so a missing read — or an owner parameter mis-set
below the floor — can never let the API accept collateral the chain would reject.

* `POST /api/loans` and `POST /api/simulate` reject collateral below
  `ceil(principal × effectiveBps / 10_000)` with a field-level `VALIDATION_ERROR` naming the
  bps and the `InsufficientCollateral` revert.
* `POST /api/loans/preview` accepts an optional `collateralEth` and, when the amount sits
  **between** the immutable floor and the pool's current minimum, returns
  `collateralSufficient: false` plus a `warnings` entry instead of an error, so the UI can
  explain "below the chain's current minimum" without blocking the user. Below the floor it is
  still a hard error.
* The live value, its source and the floor are reported in `GET /api/config.params`
  (`minCollateralBps`, `minCollateralBpsRaw`, `minCollateralBpsSource`, `minCollateralFloorBps`,
  `defaultMinCollateralBps`) and in `GET /api/pool.collateralPolicy`.

### Chain modes

`CHAIN_MODE=rpc` verifies every write: the receipt exists → `status == 1` → the receipt's `to`
is the pool contract → `tx.from` is the authenticated address → the matching event log is
found → the decoded event values equal the submitted ones. Any failure is `400` with a message
naming the mismatch; an unreachable RPC is `502 UPSTREAM_ERROR`.

`CHAIN_MODE=mock` synthesises the event from the submitted payload after running the *same*
validation code path. Accepted demo hashes are any `0x` + 64 hex characters. Two prefixes are
reserved so the failure paths stay demonstrable offline:

| Hash prefix | Behaviour |
|---|---|
| `0x00…` | transaction is reported **reverted** (`status 0`) → `400` |
| `0xff…` | receipt reports a **different sender** → `400` (wallet/actor mismatch) |
| anything else | accepted; block number and gas are derived deterministically from the hash |

### Transaction `type` values

`deposit`, `withdraw`, `loan_request`, `loan_fund`, `loan_repay`, `loan_liquidate`,
`loan_cancel`, `treasury_claim`, `initialize`, `params_update`, `paused_set`, `treasury_set`,
`ownership_transfer`.

---

## 5. Authentication flow

1. `POST /api/auth/nonce {address}` → a single-use nonce and a human-readable SIWE-style
   message, stored in `auth_nonces` with a 5-minute expiry.
2. The browser calls `personal_sign(message, address)` via MetaMask. **The private key never
   leaves the extension.**
3. `POST /api/auth/verify {address, signature}` → the backend replays the EIP-191 digest
   (`"\x19Ethereum Signed Message:\n" + len + message`), recovers the signer with a pure-Python
   secp256k1 `ecrecover`, checks it matches `address`, **burns the nonce**, and issues a bearer
   token.
4. Write routes require `Authorization: Bearer <token>`.

`recover_address()` rebuilds `R` from `r` and the recovery-id parity bit, computes
`Q = r⁻¹(sR − zG)` and additionally runs a full ECDSA verification of the recovered key, so a
malformed or forged signature is rejected rather than silently yielding some other address.

Tokens are `secrets.token_urlsafe(32)` plus an HMAC-SHA256 tag over
`token_id | address | expiresAt`; the session row is looked up, checked for expiry and
revocation, and the tag is compared with `hmac.compare_digest`.

---

## 6. Storage

SQLite with WAL, `Row` factory, foreign keys and versioned migrations (`schema_migrations`).
Tables: `users`, `auth_nonces`, `sessions`, `loans`, `loan_events`, `transactions`, plus a
one-row `pool_state` snapshot that `GET /api/pool` serves.

* **Every wei amount is stored as TEXT.** A 100 ETH principal is `1e20` wei, far beyond
  SQLite's signed 64-bit `INTEGER`; `CAST(… AS INTEGER)` would saturate. Each wei column is
  paired with an exact display-ETH TEXT column.
* Wei arithmetic is therefore done in Python (unbounded ints), never in SQL.
* `status` is stored both as the enum name and its numeric code.
* `pool_state` is updated incrementally by replaying each indexed event through the same
  accounting the contract uses, so the offline snapshot stays consistent:
  repayment credits only `netInterest + lateFee` to `totalLiquidity` (the protocol fee goes to
  `treasuryBalance` and never to `totalLiquidity`), and liquidation re-strikes the supplier
  claim at `totalLiquidity − principal + compensation`.
* Demo rows are flagged `is_demo = 1` so seeded data can never be mistaken for chain activity.

---

## 7. Security notes

* **No key material.** There is no code path that accepts, stores or logs a private key,
  mnemonic or keystore. A request body containing `privateKey` / `private_key` / `secretKey` /
  `mnemonic` / `seedPhrase` is rejected with `400` (`auth.reject_private_key_material`).
  A test scans every shipped module for signing code and for 64-hex literals that are not the
  public secp256k1 domain parameters.
* **The test signer is not production code.** `backend/tests/_test_signer.py` can sign, but it
  generates a throwaway key at run time with `secrets`, keeps it in memory only, and is never
  imported by the application. Real-wallet compatibility is pinned separately by signature
  fixtures produced by `ethers.js` v6 and re-verified through the HTTP API.
* **Signature malleability.** `ecrecover` accepts both `s` and `N − s`. That is harmless here
  because the nonce is single-use and consumed before a token is issued, so a replayed
  malleable signature cannot be re-used; it is documented rather than silently ignored.
* **Rate limiting** is a per-IP token bucket returning `429` with `Retry-After`.
* **CORS** is restricted with `CORS_ORIGINS`; the default `*` suits local grading only.
* **Errors never leak internals.** Unhandled exceptions become `500 INTERNAL_ERROR`; the
  traceback goes to the structured log, never to the response.
* **Logging** is JSON lines with request id, method, path, status, duration and IP. Bodies,
  `Authorization` headers and key material are never logged.
* This is coursework, not audited production software: use a real WSGI server, a strong
  `FLASK_SECRET_KEY`, and TLS behind a reverse proxy for anything real.

---

## 8. Notes on the spec (deliberate interpretations)

1. **Amounts are string-only.** The spec says amounts cross the API as ETH decimal strings, so
   a JSON number is rejected rather than coerced. Send `"0.05"`, not `0.05`.
2. **`loan_events.tx_hash` is UNIQUE**, as specified, so it doubles as the replay guard. A
   transaction that emits several logs (for example `LoanRequested` + `LoanActivated` in one
   call) is stored as **one** event row whose `payload` records the activation outcome. A full
   multi-log index would need a composite `(tx_hash, log_index)` key instead.
3. **405 uses the documented `NOT_FOUND` code**, because the spec's error-code list has no
   `METHOD_NOT_ALLOWED`.
4. **`pool_state` is an extra table** beyond the listed schema; it backs `GET /api/pool` so the
   endpoint returns meaningful numbers offline in `mock` mode.
5. **Non-write POSTs need no token.** `/api/loans/preview` and `/api/simulate` compute only and
   persist nothing, so they are not "write routes"; `/api/simulate` never mutates state
   (asserted by a test that diffs `/api/pool` before and after).
6. **`/api/transactions/sync` accepts optional `event` / `amountEth` / `loanId`** in `mock`
   mode, because offline there is no receipt to decode. It defaults to `LiquidityDeposited`.
   In `rpc` mode the receipt is decoded and the extra fields are ignored.
7. **`minCollateralBps` is not constant.** The contract lets the owner lower it to
   `MIN_COLLATERAL_FLOOR_BPS` (5_000), and it exposes `quoteCollateral(...)`. The API reads the
   live value (see "The collateral requirement is read live") instead of assuming 100%, so it
   neither rejects valid 50%-collateral loans after the owner lowers the parameter, nor quotes
   a loan the chain would revert on.
8. **`GET /api/loans/preview`'s documented fields are all still present**; `collateralEth`,
   `warnings`, `collateralSufficient` and `collateralPolicy` are additive and only appear when
   relevant. `collateralEth` is optional, so existing callers are unaffected.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401` on every write | Tokens are signed with a per-process random key unless `FLASK_SECRET_KEY` is set — restarting the server invalidates sessions. Set the env var. |
| `502 UPSTREAM_ERROR` | `CHAIN_MODE=rpc` without a reachable `RPC_URL`, or `MICROLEND_CONTRACT_ADDRESS` unset. |
| `400` "demo transaction is marked reverted" | The submitted hash starts with `0x00` (mock mode only). |
| `409 CONFLICT` on a create | That `txHash` was already indexed — this is the replay guard, not a bug. |
| `GET /api/loans` is empty | Seed it: `python backend/seed.py`, or delete `backend/microlend.db` and restart. |
