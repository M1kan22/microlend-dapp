"use strict";
/**
 * Suite 01 — Deployment, frozen-interface conformance and one-shot initialisation.
 * Spec: docs/INTEGRATION_SPEC.md sections 2.1-2.6 (names, signatures, units, defaults).
 */
const { H, D, SUPPLY, assertSignature, bootstrap } = require("./_helpers");

const MUTATING_SIGNATURES = [
  "initialize(address,address)",
  "deposit()",
  "withdraw(uint256)",
  "requestLoan(uint256,uint256,uint256)",
  "fundLoan(uint256)",
  "repayLoan(uint256)",
  "cancelLoan(uint256)",
  "liquidate(uint256)",
  "claimTreasury(address)",
  "setParams(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "setPaused(bool)",
  "setTreasury(address)",
  "transferOwnership(address)",
];

const VIEW_SIGNATURES = [
  "sharePrice()",
  "convertToShares(uint256)",
  "convertToAssets(uint256)",
  "getLoan(uint256)",
  "getUserLoans(address)",
  "liabilities()",
  "previewInterest(uint256,uint256,uint256)",
  "previewRepayment(uint256)",
  "collateralRatio(uint256)",
  "isOverdue(uint256)",
  "quoteCollateral(uint256,uint256,uint256)",
  "poolStats()",
  "getUserPosition(address)",
  "sharesOf(address)",
  "owner()",
  "treasury()",
  "paused()",
  "initialized()",
  "totalShares()",
  "totalLiquidity()",
  "reservedLiquidity()",
  "totalDeposited()",
  "totalInterestEarned()",
  "totalFeesCollected()",
  "totalBadDebt()",
  "treasuryBalance()",
  "loanCount()",
  "accumulatedCollateral()",
  "minDeposit()",
  "minLoanPrincipal()",
  "maxLoanPrincipal()",
  "maxDurationDays()",
  "maxRateBps()",
  "minCollateralBps()",
  "feeBps()",
  "penaltyBps()",
  "lateFeeBps()",
];

const ERROR_SIGNATURES = [
  "NotOwner()",
  "AlreadyInitialized()",
  "NotInitialized()",
  "ZeroAddress()",
  "PoolPaused()",
  "ZeroAmount()",
  "AmountTooSmall(uint256,uint256)",
  "AmountTooLarge(uint256,uint256)",
  "DurationInvalid(uint256,uint256)",
  "RateTooHigh(uint256,uint256)",
  "InsufficientCollateral(uint256,uint256)",
  "InsufficientLiquidity(uint256,uint256)",
  "InvalidLoan(uint256)",
  "LoanNotPending(uint256)",
  "LoanNotActive(uint256)",
  "LoanNotOverdue(uint256)",
  "NotBorrower(address)",
  "NotFunded(uint256,uint256)",
  "InsufficientPayment(uint256,uint256)",
  "InsufficientShares(uint256,uint256)",
  "NothingToWithdraw()",
  "NoFees()",
  "TransferFailed()",
  "Reentrancy()",
  "InvalidParameter(string)",
];

const EVENT_SIGNATURES = [
  "Initialized(address,address)",
  "LiquidityDeposited(address,uint256,uint256)",
  "LiquidityWithdrawn(address,uint256,uint256)",
  "LoanRequested(uint256,address,uint256,uint256,uint256,uint256,uint256)",
  "LoanActivated(uint256,address,uint256,uint256)",
  "LoanFunded(uint256,address,uint256,uint256)",
  "LoanRepaid(uint256,address,uint256,uint256,uint256,uint256,uint256)",
  "LoanLiquidated(uint256,address,address,uint256,uint256,uint256,uint256)",
  "LoanCancelled(uint256,address,uint256)",
  "TreasuryClaimed(address,uint256)",
  "ParamsUpdated(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "PausedSet(bool)",
  "TreasurySet(address)",
  "OwnershipTransferred(address,address)",
];

async function run(ctx, t) {
  const iface = new H.ethers.Interface(ctx.artifact.abi);

  // ---- frozen interface: every mutating + read entry point from spec 2.3 / 2.4 ----
  for (const sig of MUTATING_SIGNATURES) {
    assertSignature(t, iface, "function", sig, `ABI exposes mutating function ${sig}`);
  }
  for (const sig of VIEW_SIGNATURES) {
    assertSignature(t, iface, "function", sig, `ABI exposes read helper ${sig}`);
  }
  for (const sig of ERROR_SIGNATURES) {
    assertSignature(t, iface, "error", sig, `ABI exposes custom error ${sig}`);
  }
  for (const sig of EVENT_SIGNATURES) {
    assertSignature(t, iface, "event", sig, `ABI exposes event ${sig}`);
  }
  t.gte(ctx.artifact.abi.length, 100, "ABI exposes at least 100 entries (spec surface is complete)");

  const { pool } = await bootstrap(ctx, { deposit: false });

  // ---- pure constants ----
  const poolId = await pool.POOL_ID();
  t.eq(poolId, H.ethers.id("MICROLEND_POOL_V1"), "POOL_ID == keccak256(\"MICROLEND_POOL_V1\")");
  t.wei(await pool.BPS_DENOMINATOR(), 10_000n, "BPS_DENOMINATOR == 10_000");
  t.wei(await pool.DAYS_PER_YEAR(), 365n, "DAYS_PER_YEAR == 365");
  t.wei(await pool.DEAD_SHARES(), 1n, "DEAD_SHARES == 1");
  t.wei(await pool.MAX_FEE_BPS(), 2_000n, "MAX_FEE_BPS == 2_000");
  t.wei(await pool.MAX_PENALTY_BPS(), 2_000n, "MAX_PENALTY_BPS == 2_000");
  t.wei(await pool.MAX_LATE_FEE_BPS(), 2_000n, "MAX_LATE_FEE_BPS == 2_000");
  t.wei(await pool.LATE_PERIOD(), 30n * 86400n, "LATE_PERIOD == 30 days");
  t.wei(await pool.MIN_COLLATERAL_FLOOR_BPS(), 5_000n, "MIN_COLLATERAL_FLOOR_BPS == 5_000");

  // ---- governance defaults from spec 2.1 ----
  t.wei(await pool.minDeposit(), 10n ** 12n, "default minDeposit == 1e12 wei");
  t.wei(await pool.minLoanPrincipal(), 10n ** 13n, "default minLoanPrincipal == 1e13 wei");
  t.wei(await pool.maxLoanPrincipal(), 100n * D, "default maxLoanPrincipal == 100 ether");
  t.wei(await pool.maxDurationDays(), 365n, "default maxDurationDays == 365");
  t.wei(await pool.maxRateBps(), 5_000n, "default maxRateBps == 5_000 (50% APR ceiling)");
  t.wei(await pool.minCollateralBps(), 10_000n, "default minCollateralBps == 10_000 (100% of principal)");
  t.wei(await pool.feeBps(), 1_000n, "default feeBps == 1_000 (10% of interest)");
  t.wei(await pool.penaltyBps(), 500n, "default penaltyBps == 500 (5% liquidation penalty)");
  t.wei(await pool.lateFeeBps(), 100n, "default lateFeeBps == 100 (1% per started 30 days)");

  // ---- initial state ----
  t.eq(await pool.initialized(), true, "initialize() sets initialized = true");
  t.eq(await pool.owner(), ctx.addressOf(0), "initialize(0,0) defaults owner to msg.sender");
  t.eq(await pool.treasury(), ctx.addressOf(0), "initialize(0,0) defaults treasury to msg.sender");
  t.eq(await pool.paused(), false, "pool starts unpaused");
  t.wei(await pool.loanCount(), 0n, "loanCount starts at 0");
  t.wei(await pool.totalShares(), 0n, "totalShares starts at 0");
  t.wei(await pool.totalLiquidity(), 0n, "totalLiquidity starts at 0");
  t.wei(await pool.sharePrice(), D, "sharePrice() == 1e18 while the pool is empty (1 share == 1 wei)");

  // ---- one-shot initialiser ----
  await t.reverts(
    () => pool.initialize.staticCall(ctx.addressOf(3), ctx.addressOf(4)),
    "AlreadyInitialized",
    [],
    "initialize() a second time reverts AlreadyInitialized"
  );

  // ---- explicit treasury / owner, and the emitted lifecycle events ----
  const fresh = await ctx.deploy({ initialize: false });
  const initReceipt = await ctx.send(fresh.initialize(ctx.addressOf(3), ctx.addressOf(4)));
  t.eq(await fresh.treasury(), ctx.addressOf(3), "initialize(treasury_, owner_) stores treasury_");
  t.eq(await fresh.owner(), ctx.addressOf(4), "initialize(treasury_, owner_) stores owner_");
  t.event(initReceipt, fresh, "Initialized", [ctx.addressOf(3), ctx.addressOf(4)], "initialize emits Initialized(treasury, owner)");
  t.event(initReceipt, fresh, "TreasurySet", [ctx.addressOf(3)], "initialize emits TreasurySet(treasury)");
  t.event(initReceipt, fresh, "OwnershipTransferred", [H.ZERO_ADDRESS, ctx.addressOf(4)], "initialize emits OwnershipTransferred(0x0, owner)");
  t.noEvent(initReceipt, fresh, "PausedSet", "initialize does not emit PausedSet");

  // ---- only initializer defaults 0x0 to msg.sender ----
  const zeroInit = await ctx.deploy({ initialize: false, deployer: 5 });
  await ctx.send(zeroInit.initialize(H.ZERO_ADDRESS, H.ZERO_ADDRESS));
  t.eq(await zeroInit.owner(), ctx.addressOf(5), "initialize(0x0,0x0) uses the caller as owner");
  t.eq(await zeroInit.treasury(), ctx.addressOf(5), "initialize(0x0,0x0) uses the caller as treasury");

  // ---- every entry point is gated by whenReady until initialize() ----
  const uninit = await ctx.deploy({ initialize: false });
  const zero = H.ZERO_ADDRESS;
  const guardChecks = [
    ["deposit()", () => uninit.deposit.staticCall({ value: 10n ** 12n })],
    ["withdraw(1)", () => uninit.withdraw.staticCall(1n)],
    ["requestLoan()", () => uninit.requestLoan.staticCall(10n ** 13n, 0n, 1n, { value: 10n ** 13n })],
    ["fundLoan(1)", () => uninit.fundLoan.staticCall(1n, { value: 1n })],
    ["repayLoan(1)", () => uninit.repayLoan.staticCall(1n, { value: 1n })],
    ["cancelLoan(1)", () => uninit.cancelLoan.staticCall(1n)],
    ["liquidate(1)", () => uninit.liquidate.staticCall(1n)],
  ];
  for (const [label, thunk] of guardChecks) {
    await t.reverts(thunk, "NotInitialized", [], `${label} before initialize() reverts NotInitialized`);
  }
  // owner-gated entry points check onlyOwner first, and owner is still 0x0, so they revert NotOwner
  const ownerGateBeforeInit = [
    ["claimTreasury(0x0)", () => uninit.claimTreasury.staticCall(zero)],
    ["setParams(...)", () => uninit.setParams.staticCall(1n, 1n, 1n, 1n, 1n, 5000n, 0n, 0n, 0n)],
    ["setPaused(true)", () => uninit.setPaused.staticCall(true)],
    ["setTreasury(...)", () => uninit.setTreasury.staticCall(ctx.addressOf(1))],
    ["transferOwnership(...)", () => uninit.transferOwnership.staticCall(ctx.addressOf(1))],
  ];
  for (const [label, thunk] of ownerGateBeforeInit) {
    await t.reverts(thunk, "NotOwner", [], `${label} before initialize() reverts NotOwner (onlyOwner is checked before whenReady)`);
  }
  t.eq(await uninit.owner(), zero, "an un-initialised pool still reports owner == 0x0");
  t.eq(await uninit.initialized(), false, "un-initialised contract reports initialized == false");

  // ---- struct layout: getLoan(0) is the empty loan ----
  const empty = await pool.getLoan(999);
  t.wei(empty.id, 0n, "getLoan(unknown id).id == 0");
  t.eq(empty.borrower, H.ZERO_ADDRESS, "getLoan(unknown id).borrower == 0x0");
  t.wei(empty.status, 0n, "getLoan(unknown id).status == LoanStatus.None");
}

module.exports = { name: "01 deployment + frozen interface", run };
