// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title MicroLendPool
 * @author SC6113 Individual Assignment (Financial DApp)
 * @notice A peer-to-pool micro-lending protocol. Liquidity suppliers deposit ETH and receive
 *         pool shares that appreciate as borrowers repay simple interest. Borrowers open
 *         micro-loans by locking ETH collateral on top of the principal, and can be liquidated
 *         after their due date if they default.
 *
 * @dev Design notes
 *  - ETH-only protocol: principal, collateral, interest and fees are all denominated in wei, so
 *    no exchange-rate oracle sits in the critical path (documented as a limitation).
 *  - Share accounting is ERC-4626-style but written from scratch. The first deposit permanently
 *    parks `DEAD_SHARES` shares on the contract itself, which (a) prevents the classic
 *    first-depositor share-inflation griefing attack and (b) keeps pool shares at a 1:1 wei
 *    ratio, so a donation into the pool can never mint value for the donor.
 *  - All state-changing entry points follow Checks-Effects-Interactions and are protected by a
 *    reentrancy guard; ETH is always transferred with low-level `call` and its status is checked.
 *  - A loan either activates immediately (the pool already holds enough free liquidity) or is
 *    parked in `Pending` until suppliers fund it through `fundLoan`.
 */
contract MicroLendPool {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum LoanStatus {
        None,
        Pending,
        Active,
        Repaid,
        Liquidated,
        Cancelled
    }

    struct Loan {
        uint256 id;
        address borrower;
        uint256 principal;
        uint256 collateral;
        uint256 interest;
        uint256 rateBps;
        uint256 durationDays;
        uint256 startTime;
        uint256 dueDate;
        uint256 amountFunded;
        LoanStatus status;
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Identifier of this protocol generation, echoed for off-chain indexers.
    bytes32 public constant POOL_ID = keccak256("MICROLEND_POOL_V1");

    /// @notice Basis-point denominator (100% == 10_000 bps).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Days per year used for simple-interest pro-rating.
    uint256 public constant DAYS_PER_YEAR = 365;

    /// @notice Shares permanently parked on the contract by the first deposit (inflation guard).
    uint256 public constant DEAD_SHARES = 1;

    /// @notice Hard ceiling for the protocol interest fee (20% of interest).
    uint256 public constant MAX_FEE_BPS = 2_000;

    /// @notice Hard ceiling for the liquidation penalty (20% of debt).
    uint256 public constant MAX_PENALTY_BPS = 2_000;

    /// @notice Hard ceiling for the late fee per started 30-day period (20% of debt).
    uint256 public constant MAX_LATE_FEE_BPS = 2_000;

    /// @notice Hard floor for the collateral requirement (50% of principal). A higher value means
    ///         safer loans; anything below 100% admits a genuine default shortfall (bad debt),
    ///         which the protocol records rather than reverts on.
    uint256 public constant MIN_COLLATERAL_FLOOR_BPS = 5_000;

    /// @notice Length of one late-fee period.
    uint256 public constant LATE_PERIOD = 30 days;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    address public owner;
    address public treasury;

    bool public initialized;
    bool public paused;

    // Pool accounting
    uint256 public totalShares;
    uint256 public totalLiquidity;
    uint256 public reservedLiquidity;
    uint256 public totalDeposited;
    uint256 public totalInterestEarned;
    uint256 public totalFeesCollected;
    uint256 public totalBadDebt;
    uint256 public treasuryBalance;

    // Loan book
    uint256 public loanCount;
    uint256 public accumulatedCollateral;

    mapping(uint256 => Loan) private _loans;
    mapping(address => uint256) public sharesOf;
    mapping(address => uint256[]) private _userLoanIds;
    mapping(address => uint256) public activeLoanCountOf;
    mapping(address => uint256) public pendingLoanCountOf;

    // Governance parameters
    uint256 public minDeposit = 1e12; // 0.000001 ETH
    uint256 public minLoanPrincipal = 1e13; // 0.00001 ETH
    uint256 public maxLoanPrincipal = 100 ether;
    uint256 public maxDurationDays = 365;
    uint256 public maxRateBps = 5_000; // 50% APR
    uint256 public minCollateralBps = 10_000; // collateral must cover the principal
    uint256 public feeBps = 1_000; // 10% of interest
    uint256 public penaltyBps = 500; // 5% liquidation penalty
    uint256 public lateFeeBps = 100; // 1% per started 30-day period late

    /// @dev Reentrancy guard (1 == unlocked, 2 == locked).
    uint256 private _reentrancyStatus = 1;

    // ---------------------------------------------------------------------
    // Events (see docs/INTEGRATION_SPEC.md section 2.5)
    // ---------------------------------------------------------------------

    event Initialized(address indexed treasury, address indexed owner);
    event LiquidityDeposited(address indexed supplier, uint256 amount, uint256 sharesMinted);
    event LiquidityWithdrawn(address indexed supplier, uint256 sharesBurned, uint256 amountReturned);
    event LoanRequested(
        uint256 indexed loanId,
        address indexed borrower,
        uint256 principal,
        uint256 interest,
        uint256 rateBps,
        uint256 durationDays,
        uint256 collateral
    );
    event LoanActivated(uint256 indexed loanId, address indexed borrower, uint256 startTime, uint256 dueDate);
    event LoanFunded(uint256 indexed loanId, address indexed funder, uint256 amount, uint256 totalFunded);
    event LoanRepaid(
        uint256 indexed loanId,
        address indexed payer,
        uint256 principal,
        uint256 interest,
        uint256 lateFee,
        uint256 fee,
        uint256 totalPaid
    );
    event LoanLiquidated(
        uint256 indexed loanId,
        address indexed borrower,
        address indexed liquidator,
        uint256 collateralSeized,
        uint256 compensation,
        uint256 refund,
        uint256 badDebt
    );
    event LoanCancelled(uint256 indexed loanId, address indexed borrower, uint256 collateralRefunded);
    event TreasuryClaimed(address indexed to, uint256 amount);
    event ParamsUpdated(
        uint256 minDeposit,
        uint256 minLoanPrincipal,
        uint256 maxLoanPrincipal,
        uint256 maxDurationDays,
        uint256 maxRateBps,
        uint256 minCollateralBps,
        uint256 feeBps,
        uint256 penaltyBps,
        uint256 lateFeeBps
    );
    event PausedSet(bool paused);
    event TreasurySet(address indexed treasury);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ---------------------------------------------------------------------
    // Errors (see docs/INTEGRATION_SPEC.md section 2.6)
    // ---------------------------------------------------------------------

    error NotOwner();
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAddress();
    error PoolPaused();
    error ZeroAmount();
    error AmountTooSmall(uint256 provided, uint256 minimum);
    error AmountTooLarge(uint256 provided, uint256 maximum);
    error DurationInvalid(uint256 provided, uint256 maximum);
    error RateTooHigh(uint256 provided, uint256 maximum);
    error InsufficientCollateral(uint256 provided, uint256 required);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InvalidLoan(uint256 loanId);
    error LoanNotPending(uint256 loanId);
    error LoanNotActive(uint256 loanId);
    error LoanNotOverdue(uint256 loanId);
    error NotBorrower(address caller);
    error NotFunded(uint256 funded, uint256 principal);
    error InsufficientPayment(uint256 provided, uint256 required);
    error InsufficientShares(uint256 provided, uint256 owned);
    error NothingToWithdraw();
    error NoFees();
    error TransferFailed();
    error Reentrancy();
    error InvalidParameter(string name);

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------

    modifier nonReentrant() {
        if (_reentrancyStatus == 2) revert Reentrancy();
        _reentrancyStatus = 2;
        _;
        _reentrancyStatus = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenReady() {
        if (!initialized) revert NotInitialized();
        _;
    }

    modifier whenLive() {
        if (paused) revert PoolPaused();
        _;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice One-shot initialiser. `owner_` receives administrative rights while `treasury_`
     *         collects the protocol fee. Pass `address(0)` for either to default to the caller.
     */
    function initialize(address treasury_, address owner_) external {
        if (initialized) revert AlreadyInitialized();
        address newOwner = owner_ == address(0) ? msg.sender : owner_;
        address newTreasury = treasury_ == address(0) ? msg.sender : treasury_;

        initialized = true;
        owner = newOwner;
        treasury = newTreasury;

        emit Initialized(newTreasury, newOwner);
        emit TreasurySet(newTreasury);
        emit OwnershipTransferred(address(0), newOwner);
    }

    // ---------------------------------------------------------------------
    // Supplier side
    // ---------------------------------------------------------------------

    /**
     * @notice Deposit ETH into the lending pool and mint pool shares.
     * @return sharesMinted Shares minted to the caller (the very first deposit also parks
     *         `DEAD_SHARES` on this contract, so pool shares stay worth one wei each).
     */
    function deposit() external payable whenReady whenLive nonReentrant returns (uint256 sharesMinted) {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < minDeposit) revert AmountTooSmall(msg.value, minDeposit);

        uint256 existingShares = totalShares;
        if (existingShares == 0) {
            // Bootstrap: mint one share per wei, then split off the permanent dead share.
            if (msg.value <= DEAD_SHARES) revert AmountTooSmall(msg.value, DEAD_SHARES + 1);
            sharesMinted = msg.value - DEAD_SHARES;
            totalShares = msg.value; // includes the dead share held by this contract
        } else {
            sharesMinted = _convertToShares(msg.value);
            if (sharesMinted == 0) revert AmountTooSmall(msg.value, minDeposit);
            totalShares = existingShares + sharesMinted;
        }

        totalLiquidity += msg.value;
        totalDeposited += msg.value;
        sharesOf[msg.sender] += sharesMinted;

        emit LiquidityDeposited(msg.sender, msg.value, sharesMinted);
    }

    /**
     * @notice Burn pool shares and redeem the matching share of free pool liquidity.
     * @dev Liquidity reserved for active loans cannot be withdrawn; the caller must wait for
     *      borrowers to repay or for overdue loans to be liquidated.
     */
    function withdraw(uint256 shares) external whenReady nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        uint256 owned = sharesOf[msg.sender];
        if (shares > owned) revert InsufficientShares(shares, owned);

        assets = _convertToAssets(shares);
        if (assets == 0) revert NothingToWithdraw();
        uint256 available = _availableLiquidity();
        if (assets > available) revert InsufficientLiquidity(assets, available);

        sharesOf[msg.sender] = owned - shares;
        totalShares -= shares;
        totalLiquidity -= assets;

        emit LiquidityWithdrawn(msg.sender, shares, assets);
        _safeTransfer(msg.sender, assets);
    }

    // ---------------------------------------------------------------------
    // Borrower side
    // ---------------------------------------------------------------------

    /**
     * @notice Open a loan request, locking ETH collateral with the transaction.
     * @param principal Requested principal in wei.
     * @param rateBps Annual simple-interest rate in basis points.
     * @param durationDays Term length in days (1 .. maxDurationDays).
     * @dev If the pool holds enough free liquidity the loan activates and pays out immediately.
     *      Otherwise it stays `Pending` until funded through `fundLoan` or `cancelLoan`-ed.
     */
    function requestLoan(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) external payable whenReady whenLive nonReentrant returns (uint256 loanId) {
        if (principal == 0 || msg.value == 0) revert ZeroAmount();
        if (principal < minLoanPrincipal) revert AmountTooSmall(principal, minLoanPrincipal);
        if (principal > maxLoanPrincipal) revert AmountTooLarge(principal, maxLoanPrincipal);
        if (durationDays == 0 || durationDays > maxDurationDays) {
            revert DurationInvalid(durationDays, maxDurationDays);
        }
        if (rateBps > maxRateBps) revert RateTooHigh(rateBps, maxRateBps);

        uint256 requiredCollateral = _mulDivUp(principal, minCollateralBps, BPS_DENOMINATOR);
        if (msg.value < requiredCollateral) revert InsufficientCollateral(msg.value, requiredCollateral);

        uint256 interest = previewInterest(principal, rateBps, durationDays);

        loanId = ++loanCount;
        Loan storage loan = _loans[loanId];
        loan.id = loanId;
        loan.borrower = msg.sender;
        loan.principal = principal;
        loan.collateral = msg.value;
        loan.interest = interest;
        loan.rateBps = rateBps;
        loan.durationDays = durationDays;

        accumulatedCollateral += msg.value;
        _userLoanIds[msg.sender].push(loanId);
        pendingLoanCountOf[msg.sender] += 1;

        emit LoanRequested(loanId, msg.sender, principal, interest, rateBps, durationDays, msg.value);

        if (_availableLiquidity() >= principal) {
            _activate(loan, loanId, principal);
        } else {
            loan.status = LoanStatus.Pending;
        }
    }

    /**
     * @notice Contribute principal to a `Pending` loan request and receive pool shares for it.
     * @dev The contribution joins the pool exactly like a deposit, then the loan reserve is
     *      created. Once the request is fully funded the borrower is paid out immediately.
     */
    function fundLoan(uint256 loanId) external payable whenReady whenLive nonReentrant {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Pending) revert LoanNotPending(loanId);
        if (msg.value == 0) revert ZeroAmount();

        uint256 remaining = loan.principal - loan.amountFunded;
        if (msg.value > remaining) revert AmountTooLarge(msg.value, remaining);

        uint256 shares = _convertToShares(msg.value);
        if (shares == 0) revert AmountTooSmall(msg.value, minDeposit);

        loan.amountFunded += msg.value;
        totalShares += shares;
        totalLiquidity += msg.value;
        totalDeposited += msg.value;
        sharesOf[msg.sender] += shares;

        emit LiquidityDeposited(msg.sender, msg.value, shares);
        emit LoanFunded(loanId, msg.sender, msg.value, loan.amountFunded);

        if (loan.amountFunded == loan.principal) {
            _activate(loan, loanId, loan.principal);
        }
    }

    /**
     * @notice Repay an active loan. Any overpayment is returned to the payer.
     * @dev Repaying after the due date is allowed while the loan is still `Active`; a late fee of
     *      `lateFeeBps` per started 30-day period is added.
     */
    function repayLoan(uint256 loanId) external payable whenReady nonReentrant returns (uint256 amountDue) {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Active) revert LoanNotActive(loanId);

        uint256 lateFee;
        (amountDue, lateFee) = _previewRepayment(loan);
        if (msg.value < amountDue) revert InsufficientPayment(msg.value, amountDue);

        _settleRepayment(loan, loanId, amountDue, lateFee, msg.value - amountDue);
    }

    /**
     * @notice Cancel an unfunded loan request and recover the locked collateral.
     */
    function cancelLoan(uint256 loanId) external whenReady nonReentrant {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Pending) revert LoanNotPending(loanId);
        if (loan.borrower != msg.sender) revert NotBorrower(msg.sender);
        if (loan.amountFunded != 0) revert NotFunded(loan.amountFunded, loan.principal);

        uint256 refund = loan.collateral;
        loan.collateral = 0;
        loan.status = LoanStatus.Cancelled;
        accumulatedCollateral -= refund;
        if (pendingLoanCountOf[msg.sender] > 0) pendingLoanCountOf[msg.sender] -= 1;

        emit LoanCancelled(loanId, msg.sender, refund);
        _safeTransfer(msg.sender, refund);
    }

    /**
     * @notice Liquidate an overdue loan. Anyone may call; the caller is not paid a bounty, so the
     *         incentive is simply to keep the pool solvent.
     */
    function liquidate(uint256 loanId) external whenReady nonReentrant {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Active) revert LoanNotActive(loanId);
        if (block.timestamp <= loan.dueDate) revert LoanNotOverdue(loanId);

        (uint256 owed,) = _previewRepayment(loan);

        uint256 collateral = loan.collateral;
        uint256 compensation;
        uint256 refund;
        uint256 writeOff;

        if (collateral >= owed) {
            uint256 penalty = (owed * penaltyBps) / BPS_DENOMINATOR;
            compensation = owed + penalty;
            if (compensation > collateral) compensation = collateral;
            refund = collateral - compensation;
        } else {
            compensation = collateral;
            writeOff = owed - collateral;
            totalBadDebt += writeOff;
        }

        uint256 interest;
        unchecked {
            interest = owed > loan.principal ? owed - loan.principal : 0;
        }
        uint256 principalRecovered = owed > interest ? owed - interest : 0;
        if (principalRecovered > loan.principal) principalRecovered = loan.principal;

        // --- effects ---
        loan.collateral = 0;
        loan.status = LoanStatus.Liquidated;
        accumulatedCollateral -= collateral;
        if (activeLoanCountOf[loan.borrower] > 0) activeLoanCountOf[loan.borrower] -= 1;

        // The principal was already disbursed, so the collateral is the only recovery. Suppliers
        // receive everything seized but must give up the claim on the written-off principal; the
        // shortfall (if any) is what makes `totalLiquidity - reservedLiquidity` fall. The
        // reservation is clamped defensively so it can never underflow (which would wrap
        // `availableLiquidity` to an astronomically large number and lock the pool).
        reservedLiquidity -= loan.principal <= reservedLiquidity ? loan.principal : reservedLiquidity;
        totalLiquidity = totalLiquidity - loan.principal + compensation;
        totalInterestEarned += interest;

        emit LoanLiquidated(loanId, loan.borrower, msg.sender, collateral, compensation, refund, writeOff);

        // --- interactions ---
        if (refund > 0) _safeTransfer(loan.borrower, refund);
    }

    // ---------------------------------------------------------------------
    // Treasury / governance
    // ---------------------------------------------------------------------

    function claimTreasury(address to) external onlyOwner whenReady nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();

        uint256 available = _availableLiquidity();
        amount = treasuryBalance < available ? treasuryBalance : available;
        if (amount == 0) revert NoFees();

        // Fees move from the pool's cash into the treasury's hands. They were never part of
        // `totalLiquidity` (which tracks supplier claims), so only `treasuryBalance` decreases.
        treasuryBalance -= amount;

        emit TreasuryClaimed(to, amount);
        _safeTransfer(to, amount);
    }

    function setParams(
        uint256 minDeposit_,
        uint256 minLoanPrincipal_,
        uint256 maxLoanPrincipal_,
        uint256 maxDurationDays_,
        uint256 maxRateBps_,
        uint256 minCollateralBps_,
        uint256 feeBps_,
        uint256 penaltyBps_,
        uint256 lateFeeBps_
    ) external onlyOwner whenReady {
        if (minDeposit_ == 0) revert InvalidParameter("minDeposit");
        if (minLoanPrincipal_ == 0) revert InvalidParameter("minLoanPrincipal");
        if (maxLoanPrincipal_ < minLoanPrincipal_) revert InvalidParameter("maxLoanPrincipal");
        if (maxDurationDays_ == 0) revert InvalidParameter("maxDurationDays");
        if (maxRateBps_ == 0 || maxRateBps_ > BPS_DENOMINATOR) revert InvalidParameter("maxRateBps");
        if (minCollateralBps_ < MIN_COLLATERAL_FLOOR_BPS) revert InvalidParameter("minCollateralBps");
        if (feeBps_ > MAX_FEE_BPS) revert InvalidParameter("feeBps");
        if (penaltyBps_ > MAX_PENALTY_BPS) revert InvalidParameter("penaltyBps");
        if (lateFeeBps_ > MAX_LATE_FEE_BPS) revert InvalidParameter("lateFeeBps");

        minDeposit = minDeposit_;
        minLoanPrincipal = minLoanPrincipal_;
        maxLoanPrincipal = maxLoanPrincipal_;
        maxDurationDays = maxDurationDays_;
        maxRateBps = maxRateBps_;
        minCollateralBps = minCollateralBps_;
        feeBps = feeBps_;
        penaltyBps = penaltyBps_;
        lateFeeBps = lateFeeBps_;

        emit ParamsUpdated(
            minDeposit_,
            minLoanPrincipal_,
            maxLoanPrincipal_,
            maxDurationDays_,
            maxRateBps_,
            minCollateralBps_,
            feeBps_,
            penaltyBps_,
            lateFeeBps_
        );
    }

    function setPaused(bool paused_) external onlyOwner whenReady {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function setTreasury(address treasury_) external onlyOwner whenReady {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address newOwner) external onlyOwner whenReady {
        if (newOwner == address(0)) revert ZeroAddress();
        address previous = owner;
        owner = newOwner;
        emit OwnershipTransferred(previous, newOwner);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Wei value of one whole unit of shares (1e18 shares).
    function sharePrice() public view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) return 1e18;
        return (totalLiquidity * 1e18) / supply;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares);
    }

    function getLoan(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
    }

    /// @notice Simple interest for `principal` at `rateBps` APR over `durationDays`.
    function previewInterest(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) public pure returns (uint256) {
        return (principal * rateBps * durationDays) / (BPS_DENOMINATOR * DAYS_PER_YEAR);
    }

    /// @notice Current amount required to settle `loanId`, including any late fee.
    function previewRepayment(uint256 loanId) external view returns (uint256 amountDue, uint256 lateFee) {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Active) revert LoanNotActive(loanId);
        return _previewRepayment(loan);
    }

    /// @notice Collateral cover of an active loan in basis points (10_000 == fully covered).
    function collateralRatio(uint256 loanId) external view returns (uint256 bps) {
        Loan storage loan = _loans[loanId];
        if (loan.id == 0 || loan.id != loanId) revert InvalidLoan(loanId);
        if (loan.status != LoanStatus.Active) revert LoanNotActive(loanId);
        (uint256 owed,) = _previewRepayment(loan);
        if (owed == 0) return type(uint256).max;
        return (loan.collateral * BPS_DENOMINATOR) / owed;
    }

    function isOverdue(uint256 loanId) external view returns (bool) {
        Loan storage loan = _loans[loanId];
        if (loan.status != LoanStatus.Active) return false;
        return block.timestamp > loan.dueDate;
    }

    /// @notice Collateral that `requestLoan` would require, plus the resulting total debt.
    function quoteCollateral(
        uint256 principal,
        uint256 rateBps,
        uint256 durationDays
    ) external view returns (uint256 requiredCollateral, uint256 totalDue) {
        requiredCollateral = _mulDivUp(principal, minCollateralBps, BPS_DENOMINATOR);
        totalDue = principal + previewInterest(principal, rateBps, durationDays);
    }

    /// @notice Aggregated protocol snapshot used by the dashboard.
    function poolStats()
        external
        view
        returns (
            uint256 totalShares_,
            uint256 totalLiquidity_,
            uint256 availableLiquidity_,
            uint256 reservedLiquidity_,
            uint256 totalDeposited_,
            uint256 totalInterestEarned_,
            uint256 totalFeesCollected_,
            uint256 totalBadDebt_,
            uint256 treasuryBalance_,
            uint256 loanCount_,
            uint256 sharePrice_,
            bool paused_
        )
    {
        return (
            totalShares,
            totalLiquidity,
            _availableLiquidity(),
            reservedLiquidity,
            totalDeposited,
            totalInterestEarned,
            totalFeesCollected,
            totalBadDebt,
            treasuryBalance,
            loanCount,
            sharePrice(),
            paused
        );
    }

    /// @notice Per-wallet snapshot used by the portfolio panel.
    function getUserPosition(
        address user
    )
        external
        view
        returns (
            uint256 shares_,
            uint256 shareValue_,
            uint256 collateralLocked_,
            uint256 activeLoans_,
            uint256 pendingLoans_,
            uint256 outstandingDebt_
        )
    {
        shares_ = sharesOf[user];
        shareValue_ = _convertToAssets(shares_);
        activeLoans_ = activeLoanCountOf[user];
        pendingLoans_ = pendingLoanCountOf[user];

        uint256[] storage ids = _userLoanIds[user];
        for (uint256 i = 0; i < ids.length; ++i) {
            Loan storage loan = _loans[ids[i]];
            if (loan.status == LoanStatus.Pending || loan.status == LoanStatus.Active) {
                collateralLocked_ += loan.collateral;
            }
            if (loan.status == LoanStatus.Active) {
                (uint256 owed,) = _previewRepayment(loan);
                outstandingDebt_ += owed;
            }
        }
    }

    /// @notice All loan ids opened by `user` (including closed ones), for the history table.
    function getUserLoans(address user) external view returns (uint256[] memory) {
        return _userLoanIds[user];
    }

    /// @notice Total ETH the pool must honour, split by claimant.
    function liabilities() external view returns (uint256 supplierClaims, uint256 collateralHeld, uint256 fees) {
        return (totalLiquidity, accumulatedCollateral, treasuryBalance);
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    function _activate(Loan storage loan, uint256 loanId, uint256 funded) private {
        uint256 interest = previewInterest(loan.principal, loan.rateBps, loan.durationDays);
        loan.interest = interest;
        loan.amountFunded = funded;
        loan.status = LoanStatus.Active;
        loan.startTime = block.timestamp;
        loan.dueDate = block.timestamp + (loan.durationDays * 1 days);

        reservedLiquidity += loan.principal;
        if (pendingLoanCountOf[loan.borrower] > 0) pendingLoanCountOf[loan.borrower] -= 1;
        activeLoanCountOf[loan.borrower] += 1;

        emit LoanActivated(loanId, loan.borrower, loan.startTime, loan.dueDate);
        _safeTransfer(loan.borrower, loan.principal);
    }

    function _previewRepayment(Loan storage loan) private view returns (uint256 amountDue, uint256 lateFee) {
        uint256 base = loan.principal + loan.interest;
        if (block.timestamp > loan.dueDate) {
            uint256 lateSeconds = block.timestamp - loan.dueDate;
            uint256 periods = lateSeconds / LATE_PERIOD + 1; // charge for the started period
            lateFee = (base * lateFeeBps * periods) / BPS_DENOMINATOR;
        }
        amountDue = base + lateFee;
    }

    function _settleRepayment(
        Loan storage loan,
        uint256 loanId,
        uint256 amountDue,
        uint256 lateFee,
        uint256 refund
    ) private {
        uint256 interest = loan.interest;
        uint256 principal = loan.principal;
        uint256 collateral = loan.collateral;

        uint256 fee = (interest * feeBps) / BPS_DENOMINATOR;
        uint256 netInterest = interest - fee;

        // --- effects ---
        loan.collateral = 0;
        loan.status = LoanStatus.Repaid;
        accumulatedCollateral -= collateral;
        reservedLiquidity -= principal;
        // `reservedLiquidity` already carries the claim on the principal, so repayment only adds
        // the income the pool actually earned: net interest plus any late fee.
        totalLiquidity += netInterest + lateFee;
        totalInterestEarned += interest + lateFee;
        totalFeesCollected += fee;
        treasuryBalance += fee;
        if (activeLoanCountOf[loan.borrower] > 0) activeLoanCountOf[loan.borrower] -= 1;

        emit LoanRepaid(loanId, msg.sender, principal, interest, lateFee, fee, amountDue);

        // --- interactions ---
        if (refund > 0) _safeTransfer(msg.sender, refund);
        if (collateral > 0) _safeTransfer(loan.borrower, collateral);
    }

    function _availableLiquidity() private view returns (uint256) {
        uint256 liquidity = totalLiquidity;
        uint256 reserved = reservedLiquidity;
        return liquidity > reserved ? liquidity - reserved : 0;
    }

    function _convertToShares(uint256 assets) private view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) return assets;
        return (assets * supply) / totalLiquidity;
    }

    function _convertToAssets(uint256 shares) private view returns (uint256) {
        uint256 supply = totalShares;
        if (supply == 0) return 0;
        return (shares * totalLiquidity) / supply;
    }

    /// @dev Ceiling division: _mulDivUp(a, b, d) == ceil(a * b / d).
    function _mulDivUp(uint256 a, uint256 b, uint256 d) private pure returns (uint256) {
        uint256 product = a * b;
        if (product == 0) return 0;
        return (product + d - 1) / d;
    }

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, ) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Safety nets
    // ---------------------------------------------------------------------

    /// @dev ETH may only enter through `deposit`, `fundLoan` or a collateral payment.
    receive() external payable {
        revert ZeroAmount();
    }

    fallback() external payable {
        revert ZeroAmount();
    }
}
