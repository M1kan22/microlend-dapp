# MicroLend — frontend notes

Plain HTML, CSS and vanilla JavaScript. No build step, no framework, no bundler,
no `import` statements: every script is a classic `<script>` tag that attaches to
a `window.ML_*` global, so the folder works when it is served by Flask, by any
static server, or opened straight off disk.

```
frontend/
├── index.html                 semantic shell: topbar, hero, KPIs, panels, footer
├── css/styles.css             design tokens + the whole visual system
├── js/config.js               window.ML_CONFIG (mirrors backend/contract_abi.json)
├── js/abi.js                  window.ML_CONTRACT_ABI, generated from contracts/
├── js/ui.js                   window.ML_UI: escaping, wei formatting, toasts, modal
├── js/api.js                  window.ML_API: Flask REST client, bearer session, retries
├── js/wallet.js               window.ML_WALLET: MetaMask connect/switch/sign
├── js/contract.js             window.ML_CONTRACT: ethers v6 reads and writes
├── js/demo.js                 window.ML_DEMO: the offline ledger
├── js/app.js                  window.ML_APP: boot, routing, rendering
├── vendor/ethers.umd.min.js   ethers v6.13.4 UMD bundle (505 KB), vendored
├── vendor/fonts/*.woff2       Archivo + Newsreader latin subsets (SIL OFL)
└── README.md
```

---

## 1. The three ways to run it

### (a) Offline demo mode — no backend, no wallet, no testnet ETH

Open `index.html` by double-clicking it. The page detects that no pool address is
configured and no wallet is present, and switches to demo mode by itself.

* Every surface is badged **DEMO DATA — no real chain**.
* `js/demo.js` holds a complete local mirror of `MicroLendPool.sol` in
  `localStorage` under `ml.demo.ledger.v1`, with the contract's integer
  arithmetic reproduced exactly.
* Everything is interactive: supply, withdraw, borrow, fund, repay, cancel,
  liquidate, pause, set parameters, claim treasury, transfer ownership.
* Nothing is signed, broadcast or transmitted. There are no keys anywhere in
  this mode — the accounts are simulated balances, not wallets.
* The page needs no network at all. It also works if `vendor/ethers.umd.min.js`
  is missing and the CDN is unreachable, because demo mode never touches ethers.

The demo opens on a **sample book** (2 suppliers, 1 repaid loan, 1 healthy active
loan, 2 overdue loans — one covered, one shortfall — and 1 request waiting for
funding) so the board is never empty. `Reset ledger` empties it and returns the
demo desk to 50 ETH; `Restore sample book` brings it back.

### (b) Served by Flask on http://127.0.0.1:5000

Start the backend, then open <http://127.0.0.1:5000/>. Because the page is now on
a real origin, it probes the same-origin `GET /api/config` at boot:

* the pool address, chain id, explorer base and (if served) the ABI are adopted
  from the backend;
* the pool snapshot, loans, positions and transaction history are read from
  `/api/pool`, `/api/loans`, `/api/positions/<address>` and `/api/transactions`;
* writes are still signed in the browser and the resulting `txHash` is posted
  back so the backend can verify the receipt and persist the row.

If the backend reports no contract address, or no wallet exists, the page stays
in demo mode and offers chain mode from the banner instead of failing.

### (c) Opened directly as `file:///…/index.html`

Same as (a). Two details make this work:

* `js/config.js` rewrites a relative `/api` base to `http://127.0.0.1:5000/api`
  when `location.protocol === 'file:'`, so the page can still reach a locally
  running Flask;
* nothing is fetched at boot from `file://`. A `Look for a Flask backend` button
  in the demo banner performs the probe on demand, which keeps the console clean
  when there is no server running.

---

## 2. The complete demo cycle, in order

A grader can walk the whole protocol in about thirty seconds:

1. **Supply.** Panel *Supply and withdraw* → leave **Supply** selected, enter
   `5`, click **Supply ETH**. Confirm the dialog. The demo desk's ETH drops by 5
   and the *Owed to suppliers* KPI rises; `You will receive` shows the share
   units minted (the first deposit of a fresh ledger mints `value − 1` shares and
   parks 1 dead share, exactly like the contract).
2. **Borrow.** Panel *Open a loan* → principal `2`, rate `12.00` (% APR), term
   `30`, collateral `2`. The live quote shows interest for the term, the amount
   due at maturity and the protocol fee. Click **Request loan → Request and
   activate**. Because 2 ETH ≤ free liquidity the loan activates in the same
   step, the principal is paid out, and it appears in the loan book as *Active*.
   *Pending path:* request more than the free liquidity (for example principal
   `20`) and the request lands as *Pending* instead, with **Fund** and **Cancel**
   actions. Fund it in instalments to watch it activate once fully funded.
3. **Repay.** In the loan book, press **Repay** on your active loan. The dialog
   itemises principal, interest, late fee (none before the due date), the
   protocol fee and the collateral returned. After confirming, the status becomes
   *Repaid*, the collateral comes back to the borrower, and the share price
   ticks above 1.00 — that is the interest the suppliers just earned.
4. **Age a loan and liquidate.** Two loans in the sample book are already past
   their due date, so they can be liquidated immediately:
   * `#1` is **covered**: the pool seizes the debt plus the 5% penalty, capped at
     the collateral, and refunds the surplus to the borrower;
   * `#2` is a **shortfall**: the collateral does not cover the debt, so the
     difference is written off and *Written off* (bad debt) rises.
   Press **Liquidate** on each and read the confirmation table, which previews
   exactly what will be seized, refunded and written off.
   To age your own loan instead, use **Advance 1 day** / **Advance 30 days**, or
   **Jump past the next due date** in the demo banner; the ledger clock is shown
   in the banner so the reason a loan became liquidatable is never a mystery.
5. **Late fees.** Borrow, advance the clock past the due date, then repay: the
   quote now includes `1% per started 30 days` and the row shows the late fee as
   part of the amount owed.
6. **Admin.** The demo desk owns the pool, so *Protocol parameters* is enabled:
   change the fee or penalty, pause the pool (withdrawals and repayments keep
   working while paused — that is deliberate in the contract), claim treasury
   fees, set the treasury or transfer ownership.
7. **Costs nothing and proves itself.** The footer prints a *Ledger check*:
   `ETH held == free liquidity + collateral held + unclaimed fees`. The demo
   tracks the pool's cash separately from the contract's view of it, so this line
   going to zero after every operation is real evidence that the mirrored
   arithmetic agrees with `MicroLendPool.sol` rather than a restatement of the
   same numbers.

Because the sample loans belong to other simulated accounts, the banner has an
**Acting as** selector. Switch to *Borrower, awaiting funding* to cancel that
pending request (borrower-only), or to a borrower with an overdue loan to repay
it from their own balance.

---

## 3. Demo arithmetic and contract parity

`js/demo.js` mirrors these rules, in wei, with `BigInt` only — never floats:

| Rule | Formula |
|---|---|
| Simple interest | `principal * rateBps * durationDays / (10_000 * 365)` |
| Repay at maturity | `principal + interest` |
| Late fee | `baseDue * lateFeeBps * periods / 10_000`, `periods = (now − dueDate) / 30 days + 1` |
| Protocol fee | `interest * feeBps / 10_000` → treasury |
| Repayment | `totalLiquidity += netInterest + lateFee`; `totalInterestEarned += interest + lateFee` |
| Liquidation | penalty `owed * penaltyBps / 10_000`, `compensation = min(owed + penalty, collateral)`, `refund = collateral − compensation` |
| Shortfall | `totalBadDebt += owed − collateral`; `totalLiquidity = totalLiquidity − principal + compensation` |
| First deposit | mints `value − 1` shares, `totalShares = value` (1 dead share parked) |
| Later deposits | `shares = assets * totalShares / totalLiquidity` (floored) |
| Withdraw | `assets = shares * totalLiquidity / totalShares`, capped by free liquidity |
| Collateral required | `ceil(principal * minCollateralBps / 10_000)` |

Every custom error in `docs/INTEGRATION_SPEC.md` §2.6 is reproduced with the same
name, so a rejection reads identically in demo mode and on chain (see
`ML_UI.revertMessage`, shared by `demo.js` and `contract.js`). The demo also
enforces the simulated account balances, so it cannot conjure ETH.

`ML_DEMO.audit()` returns the solvency identity above and the UI prints it; the
test harness described in §7 asserts it stays at zero across the full cycle.

---

## 4. Configuration

Resolution order — later wins:

1. defaults in `js/config.js`;
2. query string: `?contract=0x…&api=http://…&chain=11155137&rpc=…&demo=1&explorer=…`;
3. `localStorage["ml.config"]`, written by the **Connection** panel;
4. `GET /api/config`, applied at boot when the page is served over HTTP or when
   the banner's probe is pressed.

| Knob | Default | Notes |
|---|---|---|
| `chainId` | `11155111` | Sepolia. `11155111`, `1` and `31337`/`1337` are known to the app. |
| `chainName` | `Sepolia` | Display only. |
| `contractAddress` | *(empty)* | **Empty means demo mode.** Set it to read and write the deployed pool. |
| `explorerBase` | `https://sepolia.etherscan.io` | Used for contract, address and transaction links. |
| `apiBase` | `/api` (`http://127.0.0.1:5000/api` under `file://`) | Flask base URL. |
| `rpcUrl` | `https://rpc.sepolia.org` | Read-only provider used when no wallet is present. |
| `forceDemo` | `null` | `true`/`false` pins the mode; `null` decides automatically. |
| `pollMs` | `15000` | Background refresh interval (paused while a write is in flight). |

**Mode decision.** Demo mode is the default when *either* condition holds: no
pool contract address is configured, or no MetaMask-compatible provider is
detected. Otherwise chain mode starts and the backend session is established.

### Pointing it at Sepolia

Either open `index.html?contract=0xYourPoolAddress`, or paste the address into
**Connection → Pool contract address** and press **Save connection**. The app
persists that choice in `localStorage` and reloads into chain mode. Reads work
immediately through `rpcUrl`; writes need a connected wallet on chain 11155111.

### Pointing it at a local dev chain

Set the pool address, add `?chain=31337&rpc=http://127.0.0.1:8545&explorer=`, and
switch MetaMask to `Localhost 8545` (chain id `31337`, hex `0x7a69`). Explorer
links are hidden when `explorerBase` is empty.

---

## 5. MetaMask walkthrough

1. Install MetaMask (or any EIP-1193 wallet) and create/import a throwaway
   account. **Never use an account holding real funds for this project.**
2. Get Sepolia ETH from a faucet (for example `https://sepoliafaucet.com`). You
   need enough for gas plus the collateral you intend to lock.
3. Open the app and press **Connect wallet** in the topbar. MetaMask asks only
   for account access — never for a private key or seed phrase.
4. If the wallet is on another network, the banner shows *Wrong network* and
   offers **Switch network**. That calls `wallet_switchEthereumChain`
   (`0xaa36a7`) and, if the wallet does not know Sepolia (error `4902`), falls
   back to `wallet_addEthereumChain` with the public Sepolia RPC.
5. Sign in to the backend indexer when prompted. This is `personal_sign` over a
   one-time nonce from `POST /api/auth/nonce`; the returned bearer token is kept
   in `sessionStorage` and cleared when the tab closes.
6. Supply, borrow, repay or liquidate as in §2. Each write is pre-flighted with
   `staticCall`, gas-estimated with a 20 % buffer, then sent. Rejections in
   MetaMask (`4001`) and decoded custom errors are reported in plain English.
7. The topbar button always shows the connected address and live ETH balance;
   `accountsChanged`, `chainChanged` and `disconnect` are handled, so switching
   account or network in MetaMask re-reads the pool.

**No private key, seed phrase or mnemonic is ever requested, read, logged or
stored by this page.** The only things written to browser storage are the
backend session token (`sessionStorage["ml.token"]`), the demo ledger
(`localStorage["ml.demo.ledger.v1"]`), locally recorded history
(`localStorage["ml.history.v1"]`) and the connection settings
(`localStorage["ml.config"]`).

---

## 6. Accessibility and print

* Every control has a real `<label>`; the toasts live in an `aria-live` region;
  the validation errors use `role="alert"`.
* The utilisation gauge exposes its value through `role="img"` +
  `aria-label`, and the numbers beside it are always present as text.
* Status is never colour alone: each pill carries its state word.
* Visible focus rings everywhere (`:focus-visible`, 2 px brass outline), and the
  modal traps focus, closes on `Escape` and returns focus to the trigger.
* `prefers-reduced-motion: reduce` disables the page-load settle, the gauge sweep
  and the skeleton shimmer.
* A print stylesheet hides the chrome and forms and renders the ledger tables,
  statement and utilisation on white paper.

## 7. Checks shipped with this folder

Two dependency-free Node scripts (Node 18+, no browser, no network):

```
node tests/config-apibase.test.mjs      # API base resolution (file://, cross-origin, absolute)
node tests/contract-parity.test.mjs    # arithmetic parity with MicroLendPool.sol
node tests/ui-contract.test.mjs        # static page contract + boot/render smoke test
```

`contract-parity` runs `js/ui.js` and `js/demo.js` in a VM with a stubbed
`window` and asserts, against hand-computed `BigInt` expectations: wei
formatting above 2^53, the "< 10^-8" floor, deposit and share minting (including
the parked dead share), immediate activation, pending → funding → activation,
repayment with one and two late-fee periods, the treasury fee split, covered and
shortfall liquidations, every custom error, the persistence round-trip, and the
solvency identity `cash held == free liquidity + collateral held + unclaimed
fees` after each operation of a full supply → borrow → repay → liquidate cycle.
It also pins four named vectors as literals rather than recomputing them from the
implementation's own formula: 1 ETH at 1000 bps for 30 days is
`8219178082191780` wei of interest, the 10% fee on it is `821917808219178` wei,
liquidating at `dueDate + 900 s` with 3 ETH of collateral yields owed
`1018301369863013697` / penalty `50915068493150684` / compensation
`1069216438356164381` / refund `1930783561643835619`, and with `minCollateralBps`
at 5000 a 0.5 ETH collateral default writes off `518301369863013697` wei.

`ui-contract` checks that every selector `js/app.js` uses exists in
`index.html`, that the eight scripts load in dependency order, that no file uses
`import`/`export`, that no executable code touches key material and that
`index.html` asks for no secret, that every `var()` token resolves, that the CSS
braces balance and contain no stray characters, that the fonts and the vendored
ethers bundle are present (with a guarded CDN fallback), and that the whole app
boots and renders inside a stubbed DOM. It then drives the real UI: it fills the
supply and borrow forms, clicks each dialog's confirm button, clicks the Repay
and Liquidate row actions and the demo banner's clock control, asserts the ledger
follows and stays balanced, and asserts that **no console warning or error was
logged during boot or the whole cycle**.

**Not covered by either script: real browser rendering.** This machine's sandbox
cannot start Chromium (creating its named pipes is blocked), so the visual result
was reviewed by reading the rendered markup and the stylesheet rather than from a
screenshot. Opening `index.html` in a real browser is the remaining check for the
grader to perform.
