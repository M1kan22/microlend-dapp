// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Test-only helper for suite 12. It is compiled at test time from this file and never
 * deployed to a real network. It exercises MicroLendPool's reentrancy guard by re-entering
 * the pool from inside every ETH callback the pool makes.
 */
interface IMicroLendPool {
    function deposit() external payable returns (uint256);

    function withdraw(uint256 shares) external returns (uint256);

    function requestLoan(uint256 principal, uint256 rateBps, uint256 durationDays)
        external
        payable
        returns (uint256);

    function fundLoan(uint256 loanId) external payable;

    function repayLoan(uint256 loanId) external payable returns (uint256);

    function cancelLoan(uint256 loanId) external;

    function liquidate(uint256 loanId) external;

    function claimTreasury(address to) external returns (uint256);

    function sharesOf(address user) external view returns (uint256);
}

contract ReentrancyProbe {
    IMicroLendPool public immutable pool;

    uint8 public reentryKind;      // which pool function the callback tries to re-enter
    bool public armed;             // set while an outer call is in flight
    uint256 public attempts;       // callbacks observed
    uint256 public innerReverts;   // callbacks where the inner call reverted
    uint256 public innerSuccesses; // callbacks where the inner call unexpectedly went through
    uint256 public lastRevertSelector;
    bytes public lastRevertData;

    constructor(address pool_) {
        pool = IMicroLendPool(pool_);
    }

    /// @dev ETH arrives here from the pool: attempt the configured re-entry once.
    receive() external payable {
        if (!armed) return;
        armed = false;
        uint8 kind = reentryKind;
        if (kind == 0) {
            // control mode: observe the callback without attempting a re-entry
            return;
        }
        attempts += 1;
        try this.probe(kind) {
            innerSuccesses += 1;
        } catch (bytes memory err) {
            innerReverts += 1;
            lastRevertData = err;
            if (err.length >= 4) {
                uint256 selector;
                assembly {
                    selector := shr(224, mload(add(err, 32)))
                }
                lastRevertSelector = selector;
            }
        }
    }

    /// @dev The re-entrant call itself. Executes as this contract, so msg.sender is the probe.
    function probe(uint8 kind) external {
        if (kind == 1) {
            pool.withdraw(1);
        } else if (kind == 2) {
            pool.deposit{value: 0}();
        } else if (kind == 3) {
            pool.requestLoan{value: 0}(0, 0, 0);
        } else if (kind == 4) {
            pool.fundLoan{value: 0}(1);
        } else if (kind == 5) {
            pool.repayLoan{value: 0}(1);
        } else if (kind == 6) {
            pool.cancelLoan(1);
        } else if (kind == 7) {
            pool.liquidate(1);
        } else if (kind == 8) {
            pool.claimTreasury(address(this));
        } else {
            revert("unknown kind");
        }
    }

    // ---- outer entry points, one per guarded function that makes an ETH callback ----

    function startDeposit(uint256 amount) external payable {
        pool.deposit{value: amount}();
    }

    function startWithdraw(uint8 kind) external {
        reentryKind = kind;
        armed = true;
        pool.withdraw(pool.sharesOf(address(this)));
        armed = false;
    }

    function startRequestLoan(uint8 kind, uint256 principal, uint256 rateBps, uint256 durationDays)
        external
        payable
    {
        reentryKind = kind;
        armed = true;
        pool.requestLoan{value: msg.value}(principal, rateBps, durationDays);
        armed = false;
    }

    function startFundLoan(uint8 kind, uint256 loanId) external payable {
        reentryKind = kind;
        armed = true;
        pool.fundLoan{value: msg.value}(loanId);
        armed = false;
    }

    function startRepayLoan(uint8 kind, uint256 loanId) external payable {
        reentryKind = kind;
        armed = true;
        pool.repayLoan{value: msg.value}(loanId);
        armed = false;
    }

    function startCancelLoan(uint8 kind, uint256 loanId) external {
        reentryKind = kind;
        armed = true;
        pool.cancelLoan(loanId);
        armed = false;
    }

    function startLiquidate(uint8 kind, uint256 loanId) external {
        reentryKind = kind;
        armed = true;
        pool.liquidate(loanId);
        armed = false;
    }

    function startClaimTreasury(uint8 kind, address to) external {
        reentryKind = kind;
        armed = true;
        pool.claimTreasury(to);
        armed = false;
    }
}
