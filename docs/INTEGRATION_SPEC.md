> **STATUS: FROZEN v1.0.** All names, signatures, units and error codes below are the contract
> between the Solidity contract, the Flask backend and the browser client. Do not change them
> unilaterally — message the Lead instead.

Project: **MicroLend** — a peer-to-pool micro-lending DApp (Decentralised Finance).
Network: Ethereum **Sepolia** testnet (`chainId 11155111`).

---

## 1. Domain model

| Actor | Can do |
|---|---|
| Supplier (lender) | `deposit()` ETH → receives **pool shares**; shares appreciate as interest is repaid; `withdraw(shares)` burns shares for ETH. |
| Borrower | `requestLoan(...)` posting **collateral ETH** ≥ `minCollateralBps` of principal. If the pool is liquid the loan activates instantly and principal is disbursed. Otherwise the request waits for funding (`fundLoan`) or is cancelled (`cancelLoan`). |
| Anyone | `liquidate(loanId)` once the loan is past `dueDate` and unpaid. |
| Owner (protocol admin) | `setParams(...)`, `setPaused(...)`, `setTreasury(...)`, `claimTreasury(...)`, `transferOwnership(...)`. No access to user funds beyond the protocol fee. |

Interest is **simple** interest, ETH-denominated, frozen at `requestLoan` time:

```
interestWei  = principal * rateBps * durationDays / (10_000 * 365)
baseDueWei   = principal + interestWei
```
Full repayment: the pool's claim on the principal is already recorded in `reservedLiquidity`, so
settlement credits only the earned income — `netInterest = interestWei - fee` **plus any late fee** —
to `totalLiquidity`. `fee = interestWei * feeBps / 10_000` accrues to the separate `treasuryBalance`
claim (it never enters `totalLiquidity`), and `claimTreasury` therefore reduces `treasuryBalance`
only. Net interest lifts the share price for every supplier.

Late repayment (still `Active`, `block.timestamp > dueDate`):

```
periods  = (now - dueDate) / 30 days + 1     // charge for the started period
lateFee  = baseDue * lateFeeBps * periods / 10_000
amountDue = baseDue + lateFee
```

Liquidation (`block.timestamp > dueDate`, loan still `Active`):

* `owed = amountDue` (base + late fee at liquidation time)
* if `collateral >= owed`: suppliers receive `min(owed + owed*penaltyBps/10_000, collateral)`;
  **excess collateral is refunded to the borrower**; no bad debt.
* if `collateral < owed`: suppliers receive all `collateral`; `totalBadDebt += owed - collateral`;
  the borrower receives nothing.
* in both branches the suppliers' claim is settled as `totalLiquidity += compensation - principal`,
  so they give up the principal claim and take the seizure (plus nothing extra on a shortfall).

Share accounting: pool shares are minted **1:1 with wei** on the first deposit; the first deposit
also parks `DEAD_SHARES = 1` share on the contract itself (ERC-4626 dead-share inflation guard).
Consequently `deposit` mints `amount * totalShares / totalLiquidityBefore` for later depositors and
a plain donation to the pool can never mint value for the donor.

## 2. Contract: `contracts/MicroLendPool.sol`, `contract MicroLendPool`

All ETH amounts are **wei** (`uint256`), rates are **basis points** (`1 bps = 0.01%`),
durations are **days** (`1 days`). `POOL_ID = keccak256("MICROLEND_POOL_V1")`.

### 2.1 Public state (getters)

```solidity
uint256 public totalShares;          // pool share supply (includes DEAD_SHARES)
uint256 public totalLiquidity;       // ETH owed to suppliers (wei)
uint256 public reservedLiquidity;    // principal committed to active loans (wei)
uint256 public totalDeposited;       // lifetime supplier deposits (wei)
uint256 public totalInterestEarned;  // lifetime interest charged to borrowers (wei)
uint256 public totalFeesCollected;   // lifetime protocol fees (wei)
uint256 public totalBadDebt;         // lifetime principal written off (wei)
uint256 public treasuryBalance;      // unclaimed protocol fees (wei)
uint256 public loanCount;            // number of loan requests created
uint256 public accumulatedCollateral; // pooled collateral of pending + active loans (wei)
bool    public paused;
bool    public initialized;
address public owner;
address public treasury;

uint256 public minDeposit;        // default 1e12 wei
uint256 public minLoanPrincipal;  // default 1e13 wei
uint256 public maxLoanPrincipal;  // default 100 ether
uint256 public maxDurationDays;   // default 365
uint256 public maxRateBps;        // default 5000   (50% APR ceiling)
uint256 public minCollateralBps;  // default 10000  (100% of principal; settable down to the 5000 floor)
uint256 public feeBps;            // default 1000   (10% of interest)
uint256 public penaltyBps;        // default 500    (5% liquidation penalty)
uint256 public lateFeeBps;        // default 100    (1% per started 30 days late)
```

Constants: `BPS_DENOMINATOR = 10_000`, `DAYS_PER_YEAR = 365`, `DEAD_SHARES = 1`,
`MAX_FEE_BPS = 2_000`, `MAX_PENALTY_BPS = 2_000`, `MAX_LATE_FEE_BPS = 2_000`,
`MIN_COLLATERAL_FLOOR_BPS = 5_000`, `LATE_PERIOD = 30 days`.
The floor exists so the owner can *never* set a collateral requirement above 200% or below 50% of
principal; a value below 10_000 deliberately admits a possible default shortfall so the bad-debt
branch is reachable and testable. `MIN_COLLATERAL_FLOOR_BPS` is a public constant and is part of the
ABI on purpose.

### 2.2 Structs

```solidity
enum LoanStatus { None, Pending, Active, Repaid, Liquidated, Cancelled }

struct Loan {
    uint256 id;
    address borrower;
    uint256 principal;     // wei
    uint256 collateral;    // wei held in the contract
    uint256 interest;      // frozen total interest (wei)
    uint256 rateBps;
    uint256 durationDays;
    uint256 startTime;     // 0 while Pending
    uint256 dueDate;       // 0 while Pending
    uint256 amountFunded;  // wei of principal funded so far
    LoanStatus status;
}
```

### 2.3 Mutating functions — EXACT signatures

```solidity
function initialize(address treasury_, address owner_) external;   // callable once; 0x0 -> msg.sender
function deposit() external payable returns (uint256 sharesMinted);
function withdraw(uint256 shares) external returns (uint256 assets);
function requestLoan(uint256 principal, uint256 rateBps, uint256 durationDays)
    external payable returns (uint256 loanId);
function fundLoan(uint256 loanId) external payable;
function repayLoan(uint256 loanId) external payable returns (uint256 amountDue);
function cancelLoan(uint256 loanId) external;
function liquidate(uint256 loanId) external;
function claimTreasury(address to) external returns (uint256 amount);          // owner only
function setParams(uint256 minDeposit_, uint256 minLoanPrincipal_, uint256 maxLoanPrincipal_,
                   uint256 maxDurationDays_, uint256 maxRateBps_, uint256 minCollateralBps_,
                   uint256 feeBps_, uint256 penaltyBps_, uint256 lateFeeBps_) external; // owner only
function setPaused(bool paused_) external;                                     // owner only
function setTreasury(address treasury_) external;                              // owner only
function transferOwnership(address newOwner) external;                         // owner only
```

### 2.4 Read helpers — EXACT signatures

```solidity
function sharePrice() external view returns (uint256);            // wei per 1e18 shares
function convertToShares(uint256 assets) external view returns (uint256);
function convertToAssets(uint256 shares) external view returns (uint256);
function getLoan(uint256 loanId) external view returns (Loan memory);
function getUserLoans(address user) external view returns (uint256[] memory);
function liabilities() external view returns (uint256 supplierClaims, uint256 collateralHeld, uint256 fees);
function previewInterest(uint256 principal, uint256 rateBps, uint256 durationDays) external pure returns (uint256);
function previewRepayment(uint256 loanId) external view returns (uint256 amountDue, uint256 lateFee);
function collateralRatio(uint256 loanId) external view returns (uint256 bps);   // collateral*10000/totalDue
function isOverdue(uint256 loanId) external view returns (bool);
function quoteCollateral(uint256 principal, uint256 rateBps, uint256 durationDays)
    external view returns (uint256 requiredCollateral, uint256 totalDue);
function poolStats() external view returns (
    uint256 totalShares_, uint256 totalLiquidity_, uint256 availableLiquidity_, uint256 reservedLiquidity_,
    uint256 totalDeposited_, uint256 totalInterestEarned_, uint256 totalFeesCollected_,
    uint256 totalBadDebt_, uint256 treasuryBalance_, uint256 loanCount_, uint256 sharePrice_, bool paused_);
function getUserPosition(address user) external view returns (
    uint256 shares_, uint256 shareValue_, uint256 collateralLocked_, uint256 activeLoans_,
    uint256 pendingLoans_, uint256 outstandingDebt_);
```

`availableLiquidity = totalLiquidity - reservedLiquidity` (clamped at 0).

### 2.5 Events — EXACT signatures (the backend indexes these)

```solidity
event Initialized(address indexed treasury, address indexed owner);
event LiquidityDeposited(address indexed supplier, uint256 amount, uint256 sharesMinted);
event LiquidityWithdrawn(address indexed supplier, uint256 sharesBurned, uint256 amountReturned);
event LoanRequested(uint256 indexed loanId, address indexed borrower, uint256 principal,
                    uint256 interest, uint256 rateBps, uint256 durationDays, uint256 collateral);
event LoanActivated(uint256 indexed loanId, address indexed borrower, uint256 startTime, uint256 dueDate);
event LoanFunded(uint256 indexed loanId, address indexed funder, uint256 amount, uint256 totalFunded);
event LoanRepaid(uint256 indexed loanId, address indexed payer, uint256 principal, uint256 interest,
                 uint256 lateFee, uint256 fee, uint256 totalPaid);
event LoanLiquidated(uint256 indexed loanId, address indexed borrower, address indexed liquidator,
                     uint256 collateralSeized, uint256 compensation, uint256 refund, uint256 badDebt);
event LoanCancelled(uint256 indexed loanId, address indexed borrower, uint256 collateralRefunded);
event TreasuryClaimed(address indexed to, uint256 amount);
event ParamsUpdated(uint256 minDeposit, uint256 minLoanPrincipal, uint256 maxLoanPrincipal,
                    uint256 maxDurationDays, uint256 maxRateBps, uint256 minCollateralBps,
                    uint256 feeBps, uint256 penaltyBps, uint256 lateFeeBps);
event PausedSet(bool paused);
event TreasurySet(address indexed treasury);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
```

`LoanStatus` enum is encoded in the ABI as `uint8`: `0 None, 1 Pending, 2 Active, 3 Repaid,
4 Liquidated, 5 Cancelled`.

### 2.6 Custom errors — EXACT names

```solidity
error NotOwner(); error AlreadyInitialized(); error NotInitialized(); error ZeroAddress();
error PoolPaused(); error ZeroAmount();
error AmountTooSmall(uint256 provided, uint256 minimum);
error AmountTooLarge(uint256 provided, uint256 maximum);
error DurationInvalid(uint256 provided, uint256 maximum);
error RateTooHigh(uint256 provided, uint256 maximum);
error InsufficientCollateral(uint256 provided, uint256 required);
error InsufficientLiquidity(uint256 requested, uint256 available);
error InvalidLoan(uint256 loanId); error LoanNotPending(uint256 loanId);
error LoanNotActive(uint256 loanId); error LoanNotOverdue(uint256 loanId);
error NotBorrower(address caller); error NotFunded(uint256 funded, uint256 principal);
error InsufficientPayment(uint256 provided, uint256 required);
error InsufficientShares(uint256 provided, uint256 owned);
error NothingToWithdraw(); error NoFees(); error TransferFailed(); error Reentrancy();
error InvalidParameter(string name);
```

### 2.7 Behavioural rules the tests assert

1. `deposit` reverts `AmountTooSmall` below `minDeposit`, and reverts `PoolPaused` while paused. The
   first deposit mints `value - 1` shares to the depositor and parks 1 dead share on the contract.
2. A plain ETH transfer to the contract reverts `ZeroAmount` (the `receive`/`fallback` hooks reject it).
3. `withdraw(0)` reverts `ZeroAmount`; `withdraw(> sharesOf[caller])` reverts `InsufficientShares`;
   `withdraw` is **allowed while paused** (users must always be able to exit) and reverts
   `InsufficientLiquidity` when the request exceeds free liquidity (liquidity reserved for active
   loans is untouchable).
4. `requestLoan` validates: `principal >= minLoanPrincipal`, `principal <= maxLoanPrincipal`,
   `1 <= durationDays <= maxDurationDays`, `rateBps <= maxRateBps`, and `msg.value` (collateral) at
   least `ceil(principal * minCollateralBps / 10_000)` — reverting `InsufficientCollateral` otherwise.
5. With enough free liquidity the loan activates immediately (`LoanActivated`, principal paid out);
   otherwise it becomes `Pending`.
6. `fundLoan` reverts `LoanNotPending` on a non-pending loan, mints shares for the contribution, and
   activates the loan once `amountFunded == principal`, paying the borrower.
7. `repayLoan` requires `msg.value >= amountDue` (`InsufficientPayment`), refunds any overpayment to
   the payer, returns the collateral to the borrower, sets status `Repaid`; a second repayment
   reverts `LoanNotActive`.
8. `liquidate` before `dueDate` reverts `LoanNotOverdue`; after it settles the loan, refunds excess
   collateral to the borrower and records `totalBadDebt` only on a shortfall. Calling it twice
   reverts `LoanNotActive`.
9. `cancelLoan` is borrower-only (`NotBorrower`), requires `Pending` and `amountFunded == 0`
   (`NotFunded`), and refunds the collateral.
10. Reentrancy: `deposit`, `withdraw`, `requestLoan`, `fundLoan`, `repayLoan`, `cancelLoan`,
    `liquidate`, `claimTreasury` are all non-reentrant.
11. Governance: `setParams` rejects `feeBps > 2000`, `penaltyBps > 2000`, `lateFeeBps > 2000`,
    `maxDurationDays == 0`, `maxRateBps == 0`, `minCollateralBps < 5000`, zero `minDeposit`, and
    `maxLoanPrincipal < minLoanPrincipal` — all via `InvalidParameter`; non-owners get `NotOwner`.
    Lowering `minCollateralBps` below 10_000 is what makes a genuine default **shortfall** possible:
    the seizure is capped at the collateral, and `totalBadDebt` records the uncovered remainder.
12. Money invariant — assert this exact identity after **every** scenario in every suite:

    ```
    address(pool).balance == (totalLiquidity - reservedLiquidity)
                           + accumulatedCollateral
                           + treasuryBalance
    ```

    Reading: `totalLiquidity` is the suppliers' claim on the pool and **includes** the principal
    committed to active loans; `reservedLiquidity` is the part of that claim currently lent out, so
    `totalLiquidity - reservedLiquidity` is the cash the pool still holds for suppliers. The dead
    share (`DEAD_SHARES = 1`) is a share inside `totalShares`, not extra wei, so it must **not**
    appear in this identity. Corollaries the tests should also assert:
    `reservedLiquidity <= totalLiquidity`, `availableLiquidity == totalLiquidity - reservedLiquidity`,
    and `totalBadDebt == 0` until a shortfall liquidation happens. When a default shortfall occurs,
    suppliers are the residual claimant: the identity still holds exactly and
    `totalLiquidity - reservedLiquidity` shows the realised loss.

## 3. Backend REST API (Flask), base `/api`, JSON only

All responses are `{"ok": true, "data": ...}` or
`{"ok": false, "error": {"code": "...", "message": "...", "fields": {...}}}`.
Error codes: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `AUTH_INVALID`, `NOT_FOUND`, `CONFLICT`,
`UPSTREAM_ERROR`, `RATE_LIMITED`, `INTERNAL_ERROR`. HTTP: 200/201/400/401/404/409/429/500/502.

```
GET    /api/health
GET    /api/config
POST   /api/auth/nonce          {address}                     -> 201 {address, nonce, message, expiresAt}
POST   /api/auth/verify         {address, signature}          -> 200 {token, address, expiresAt}
GET    /api/auth/session        Authorization: Bearer <token> -> 200 {address, expiresAt}
POST   /api/auth/logout                                       -> 200 {loggedOut: true}
GET    /api/pool                                              -> 200 pool snapshot + contract metadata
GET    /api/loans?status=&borrower=&limit=&offset=            -> 200 {items, total, limit, offset}
GET    /api/loans/<loan_id>                                   -> 200 loan
GET    /api/loans/<loan_id>/history                           -> 200 {items: [...]}
POST   /api/loans/preview       {principalEth, rateBps, durationDays} -> 200 {principalWei, interestWei, interestEth, totalDueWei, totalDueEth, requiredCollateralWei, requiredCollateralEth, aprPercent}
POST   /api/loans               {principalEth, rateBps, durationDays, collateralEth, txHash} -> 201 loan
POST   /api/loans/<loan_id>/fund        {amountEth, txHash}    -> 200 loan
POST   /api/loans/<loan_id>/repay       {amountEth, txHash}    -> 200 loan
POST   /api/loans/<loan_id>/liquidate   {txHash}               -> 200 loan
GET    /api/transactions?address=&type=&status=&limit=&offset= -> 200 {items, total, limit, offset}
POST   /api/transactions/sync   {txHash}                       -> 200 transaction
GET    /api/positions/<address>                                -> 200 position + user loans
POST   /api/simulate            {action, params}               -> 200 {allowed, errors, warnings, estimate}
```

Rules: the backend **never** receives or stores a private key. Every write endpoint requires a
Bearer token whose address matches the on-chain actor, verifies the submitted `txHash` receipt
against the chain (`CHAIN_MODE=rpc`; `CHAIN_MODE=mock` accepts an annotated demo hash for offline
grading), decodes the matching event, and only then persists the row. Amounts cross the API as ETH
decimal strings (`"0.05"`) and are stored as integer wei strings plus a display ETH string.

### 3.1 `POST /api/transactions/sync` — request body (amended)

The body is `{txHash, event?, amountEth?, loanId?}`; `txHash` is the only required field but the
event-specific fields below are required for the row to be accepted, because every submitted value is
reconciled against the decoded on-chain log:

| `event` (default `LiquidityDeposited`) | additionally requires |
|---|---|
| `LiquidityDeposited` | `amountEth` — must equal the log's `amount` **and** its `sharesMinted` |
| `LiquidityWithdrawn` | `amountEth` — must equal `sharesBurned` and `amountReturned` |
| `LoanRequested` / `LoanActivated` / `LoanFunded` | `loanId` (must already be in the index), `amountEth` |
| `LoanRepaid` | `loanId`, `amountEth` |
| `LoanLiquidated` | `loanId` |

Known limitation (open): the first-ever deposit into a fresh pool parks `DEAD_SHARES = 1`, so the
chain emits `sharesMinted = amount - 1` and the strict equality above rejects that one bootstrap
deposit (`400 VALIDATION_ERROR`). Every later deposit indexes normally. Fixing it means accepting
`sharesMinted ∈ {amount, amount-1}` or letting the caller supply `sharesMinted`; see
`docs/E2E-VERIFICATION.md` for the reproducing run. A tx hash that has already been indexed is
refused with `409 CONFLICT`.

## 4. Frontend contract

`frontend/index.html` + `frontend/css/styles.css` + `frontend/js/*.js` (vanilla JS). Constants live in
`frontend/js/config.js` and must mirror `backend/contract_abi.json` (`chainId`, `chainName`,
`contractAddress`, `explorerBase`, `apiBase`). Wallet access goes through `window.ethereum` (MetaMask)
with `eth_requestAccounts`, `wallet_switchEthereumChain` (`0xaa36a7`), and `personal_sign` for the
backend session. **No private key ever touches browser storage.** Globals:
`window.ML_CONFIG`, `window.ML_CONTRACT_ABI`, `window.ML_API`, `window.ML_WALLET`, `window.ML_UI`
(`escapeHtml`, `formatEth`, `shortenAddress`, `toast`, `setBusy`). All user-controlled strings must be
escaped before insertion into the DOM.

## 5. Ownership (write scopes — do not write outside yours)

| Path | Owner |
|---|---|
| `contracts/**`, `test/**`, `scripts/**`, `artifacts/**` | teammate `contract-chain` |
| `backend/**` | teammate `backend-api` |
| `frontend/**` | teammate `frontend-ui` |
| `README.md`, `docs/REPORT.md`, `docs/TESTING.md`, `docs/SCREENSHOTS.md` | teammate `docs-qa` |
| `docs/INTEGRATION_SPEC.md`, `dist/**`, `package.json`, `.env.example` | Lead |
