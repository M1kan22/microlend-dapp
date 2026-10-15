"""Deterministic offline demo data for the MicroLend indexer.

Why this exists: ``CHAIN_MODE=mock`` must let the whole DApp be demonstrated and graded with
no testnet, no RPC endpoint and no wallet.  ``python backend/app.py`` therefore seeds a fresh
database on first start so ``GET /api/pool``, ``GET /api/loans`` and ``GET /api/positions/...``
return meaningful data immediately.

Two properties matter:

1. **Every row is flagged** ``is_demo = 1`` so seeded data can never be mistaken for indexed
   on-chain activity.
2. **The pool snapshot is internally consistent** because it is built by replaying each
   fixture through the *same* ``db.apply_*`` helpers the live indexer uses.  That keeps the
   indexed view aligned with the money identity in spec section 2.7(12)::

       pool balance == (totalLiquidity - reservedLiquidity)
                       + accumulatedCollateral
                       + treasuryBalance

   ``demo_seed.check_consistency`` asserts the parts the indexer can see offline.

Nothing here signs, transfers or holds value; the fixtures are just numbers in SQLite.
"""

from __future__ import annotations

import time
from typing import Any, Iterable

import db
import validation
from keccak import keccak256

SECONDS_PER_DAY = 86_400

# Demo wallets (obviously synthetic; not derived from any real key).
SUPPLIERS = (
    ("0x1111111111111111111111111111111111111111", "150"),
    ("0x2222222222222222222222222222222222222222", "100"),
)
BORROWERS = {
    # Deliberately all-lowercase so they are valid addresses without an EIP-55 checksum,
    # which keeps the fixtures readable while still exercising address normalisation.
    "anna": "0xa11ce0000000000000000000000000000000a001",
    "bruno": "0xb0b0000000000000000000000000000000000b002",
    "chen": "0xc0ffee00000000000000000000000000000c003",
    "dara": "0xdada0000000000000000000000000000000d004",
    "elif": "0xe11f0000000000000000000000000000000e005",
}

# loan_id, borrower, principal ETH, rate bps, duration days, collateral ETH, status,
# start offset in days (negative = in the past), settlement offset in days (None = still open)
LOAN_FIXTURES: tuple[dict[str, Any], ...] = (
    {
        "loan_id": 1,
        "borrower": "anna",
        "principal": "8",
        "rate_bps": 1_800,
        "duration_days": 30,
        "collateral": "8.4",
        "status": "Active",
        "start_days": -10,
        "final_days": None,
    },
    {
        "loan_id": 2,
        "borrower": "bruno",
        "principal": "3.5",
        "rate_bps": 2_400,
        "duration_days": 14,
        "collateral": "3.85",
        "status": "Active",
        "start_days": -3,
        "final_days": None,
    },
    {
        "loan_id": 3,
        "borrower": "anna",
        "principal": "12",
        "rate_bps": 1_500,
        "duration_days": 60,
        "collateral": "12",
        "status": "Repaid",
        "start_days": -90,
        "final_days": -35,
    },
    {
        # Deliberately overdue so /api/loans/<id>/liquidate and /api/simulate are demoable.
        "loan_id": 4,
        "borrower": "chen",
        "principal": "5",
        "rate_bps": 3_000,
        "duration_days": 45,
        "collateral": "5.5",
        "status": "Active",
        "start_days": -60,
        "final_days": None,
    },
    {
        "loan_id": 5,
        "borrower": "dara",
        "principal": "20",
        "rate_bps": 2_200,
        "duration_days": 90,
        "collateral": "20",
        "status": "Pending",
        "start_days": None,
        "final_days": None,
    },
    {
        # Collateral covers the principal but not principal+interest, so liquidating it
        # realises a genuine bad-debt shortfall (the branch spec section 2.7(11) describes).
        "loan_id": 6,
        "borrower": "elif",
        "principal": "6",
        "rate_bps": 1_200,
        "duration_days": 30,
        "collateral": "6.1",
        "status": "Liquidated",
        "start_days": -120,
        "final_days": -85,
    },
    {
        "loan_id": 7,
        "borrower": "bruno",
        "principal": "2",
        "rate_bps": 900,
        "duration_days": 7,
        "collateral": "2",
        "status": "Cancelled",
        "start_days": None,
        "final_days": -1,
    },
)


def demo_tx_hash(seed: str) -> str:
    """Deterministic synthetic hash that is a valid ``0x`` + 64 hex and not a mock sentinel."""
    counter = 0
    while True:
        digest = keccak256(f"microlend-demo:{seed}:{counter}".encode("utf-8")).hex()
        if not digest.startswith(("00", "ff")):
            return "0x" + digest
        counter += 1


def is_seeded(conn) -> bool:
    row = conn.execute("SELECT COUNT(*) AS n FROM loans").fetchone()
    return int(row["n"]) > 0


def reset(conn) -> None:
    """Remove every demo/indexed row and reset the pool snapshot to zero."""
    for table in ("loan_events", "transactions", "loans", "auth_nonces", "sessions", "users"):
        conn.execute(f"DELETE FROM {table}")
    db.init_db(conn)
    db.set_pool_state(
        conn,
        total_shares_wei=0,
        total_liquidity_wei=0,
        reserved_liquidity_wei=0,
        total_deposited_wei=0,
        total_interest_wei=0,
        total_fees_wei=0,
        total_bad_debt_wei=0,
        treasury_balance_wei=0,
        accumulated_collateral_wei=0,
        loan_count=0,
        paused=False,
        is_demo=True,
        min_collateral_bps=validation.DEFAULT_MIN_COLLATERAL_BPS,
    )


def ensure_seed(conn, *, force: bool = False, now: int | None = None) -> dict:
    """Seed the demo data when the database is empty (or unconditionally with ``force``)."""
    now = int(time.time()) if now is None else now
    if is_seeded(conn) and not force:
        return {"seeded": False, "reason": "database already contains loans"}

    if force:
        reset(conn)

    # ---- suppliers: two deposits, 250 ETH total --------------------------
    total_deposited = 0
    for index, (address, amount_eth) in enumerate(SUPPLIERS):
        amount = validation.eth_to_wei(amount_eth, "amount")
        total_deposited += amount
        occurred = now - (200 - index * 10) * SECONDS_PER_DAY
        tx_hash = demo_tx_hash(f"deposit:{address}")
        db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=address,
            type_="deposit",
            amount_wei=amount,
            gas_used=46_000 + index * 1_000,
            block_number=1_800_000 + index,
            description=f"Supplied {amount_eth} ETH of liquidity to the pool",
            is_demo=True,
            created_at=occurred,
        )

    # The first deposit mints one share per wei (DEAD_SHARES included), so shares == deposit.
    # minCollateralBps starts at the contract's initial 10_000; every fixture posts >= 100%
    # collateral, so the seeded loans stay valid if the owner lowers it later.
    db.set_pool_state(
        conn,
        total_shares_wei=total_deposited,
        total_deposited_wei=total_deposited,
        total_liquidity_wei=total_deposited,
        loan_count=0,
        is_demo=True,
        min_collateral_bps=validation.DEFAULT_MIN_COLLATERAL_BPS,
    )

    # ---- loans -----------------------------------------------------------
    active_loans = 0
    for fixture in LOAN_FIXTURES:
        _seed_loan(conn, fixture, now)
        if fixture["status"] == "Active":
            active_loans += 1

    # ---- bookkeeping ------------------------------------------------------
    snapshot = db.pool_snapshot(conn)
    db.insert_transaction(
        conn,
        tx_hash=demo_tx_hash("treasury:seed"),
        address=SUPPLIERS[0][0],
        type_="treasury_claim",
        amount_wei=0,
        gas_used=30_000,
        block_number=1_800_100,
        description="Protocol fee accrual (no claim yet)",
        is_demo=True,
        created_at=now - 5 * SECONDS_PER_DAY,
    )
    return {
        "seeded": True,
        "loans": len(LOAN_FIXTURES),
        "activeLoans": active_loans,
        "transactions": db.table_counts(conn)["transactions"],
        "pool": {
            "totalDepositedEth": snapshot["totalDepositedEth"],
            "totalLiquidityEth": snapshot["totalLiquidityEth"],
            "reservedLiquidityEth": snapshot["reservedLiquidityEth"],
            "availableLiquidityEth": snapshot["availableLiquidityEth"],
            "accumulatedCollateralEth": snapshot["accumulatedCollateralEth"],
            "treasuryBalanceEth": snapshot["treasuryBalanceEth"],
            "totalBadDebtEth": snapshot["totalBadDebtEth"],
        },
    }


def _seed_loan(conn, fixture: dict[str, Any], now: int) -> None:
    status = fixture["status"]
    principal = validation.eth_to_wei(fixture["principal"], "principal")
    collateral = validation.eth_to_wei(fixture["collateral"], "collateral")
    rate_bps = fixture["rate_bps"]
    duration_days = fixture["duration_days"]
    interest = validation.preview_interest_wei(principal, rate_bps, duration_days)
    borrower = BORROWERS[fixture["borrower"]]

    start_time = 0
    due_date = 0
    if fixture["start_days"] is not None:
        start_time = now + fixture["start_days"] * SECONDS_PER_DAY
        due_date = start_time + duration_days * SECONDS_PER_DAY

    funded = 0
    if status in ("Active", "Repaid", "Liquidated"):
        funded = principal

    tx_requested = demo_tx_hash(f"loan{fixture['loan_id']}:requested")
    created_at = start_time or (now + (fixture["final_days"] or -2) * SECONDS_PER_DAY)

    db.insert_loan(
        conn,
        {
            "loan_id": fixture["loan_id"],
            "borrower": borrower,
            "principal_wei": principal,
            "collateral_wei": collateral,
            "interest_wei": interest,
            "rate_bps": rate_bps,
            "duration_days": duration_days,
            "start_time": start_time,
            "due_date": due_date,
            "status_code": validation.STATUS_TO_CODE[status.lower()],
            "funded_wei": funded,
            "tx_hash_created": tx_requested,
            "tx_hash_repaid": demo_tx_hash(f"loan{fixture['loan_id']}:repaid")
            if status == "Repaid"
            else None,
            "is_demo": True,
            "created_at": created_at,
        },
    )

    # Replay the exact pool deltas the live indexer would apply for this loan's lifecycle,
    # so the seeded snapshot is consistent by construction.
    db.apply_request_to_pool(
        conn,
        collateral_wei=collateral,
        activated=status in ("Active", "Repaid", "Liquidated"),
        principal_wei=principal,
    )
    db.insert_event(
        conn,
        loan_id=fixture["loan_id"],
        event_type="LoanRequested",
        actor=borrower,
        amount_wei=collateral,
        block_number=1_800_200 + fixture["loan_id"],
        tx_hash=tx_requested,
        payload={
            "principalWei": str(principal),
            "interestWei": str(interest),
            "rateBps": rate_bps,
            "durationDays": duration_days,
            "collateralWei": str(collateral),
            "activated": status in ("Active", "Repaid", "Liquidated"),
            "demo": True,
        },
        is_demo=True,
        created_at=created_at,
    )
    db.insert_transaction(
        conn,
        tx_hash=tx_requested,
        address=borrower,
        type_="loan_request",
        amount_wei=collateral,
        gas_used=210_000 + fixture["loan_id"] * 1_000,
        block_number=1_800_200 + fixture["loan_id"],
        description=(
            f"Requested a {fixture['principal']} ETH loan at "
            f"{validation.bps_to_percent(rate_bps)}% APR for {duration_days} days"
        ),
        loan_id=fixture["loan_id"],
        is_demo=True,
        created_at=created_at,
    )

    if status == "Repaid":
        settled = now + (fixture["final_days"] or 0) * SECONDS_PER_DAY
        breakdown = validation.repayment_breakdown(principal, interest, due_date, settled)
        db.apply_repayment_to_pool(
            conn,
            principal_wei=principal,
            interest_wei=interest,
            late_fee_wei=breakdown["lateFeeWei"],
            fee_wei=breakdown["feeWei"],
            collateral_wei=collateral,
        )
        db.insert_event(
            conn,
            loan_id=fixture["loan_id"],
            event_type="LoanRepaid",
            actor=borrower,
            amount_wei=breakdown["amountDueWei"],
            block_number=1_800_300 + fixture["loan_id"],
            tx_hash=db.get_loan_row(conn, fixture["loan_id"])["tx_hash_repaid"],
            payload={
                "principalWei": str(principal),
                "interestWei": str(interest),
                "lateFeeWei": str(breakdown["lateFeeWei"]),
                "feeWei": str(breakdown["feeWei"]),
                "netInterestWei": str(breakdown["netInterestWei"]),
                "demo": True,
            },
            is_demo=True,
            created_at=settled,
        )
        db.insert_transaction(
            conn,
            tx_hash=db.get_loan_row(conn, fixture["loan_id"])["tx_hash_repaid"],
            address=borrower,
            type_="loan_repay",
            amount_wei=breakdown["amountDueWei"],
            gas_used=120_000,
            block_number=1_800_300 + fixture["loan_id"],
            description=f"Repaid loan {fixture['loan_id']} in full",
            loan_id=fixture["loan_id"],
            is_demo=True,
            created_at=settled,
        )

    elif status == "Liquidated":
        settled = now + (fixture["final_days"] or 0) * SECONDS_PER_DAY
        breakdown = validation.liquidation_breakdown(
            principal, interest, collateral, due_date, settled
        )
        db.apply_liquidation_to_pool(
            conn,
            principal_wei=principal,
            compensation_wei=breakdown["compensationWei"],
            collateral_wei=collateral,
            bad_debt_wei=breakdown["badDebtWei"],
            interest_wei=breakdown["interestRecoveredWei"],
        )
        tx_liquidated = demo_tx_hash(f"loan{fixture['loan_id']}:liquidated")
        db.insert_event(
            conn,
            loan_id=fixture["loan_id"],
            event_type="LoanLiquidated",
            actor=SUPPLIERS[0][0],
            amount_wei=breakdown["compensationWei"],
            block_number=1_800_400 + fixture["loan_id"],
            tx_hash=tx_liquidated,
            payload={
                "collateralSeizedWei": str(collateral),
                "compensationWei": str(breakdown["compensationWei"]),
                "refundWei": str(breakdown["refundWei"]),
                "badDebtWei": str(breakdown["badDebtWei"]),
                "owedWei": str(breakdown["owedWei"]),
                "demo": True,
            },
            is_demo=True,
            created_at=settled,
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_liquidated,
            address=SUPPLIERS[0][0],
            type_="loan_liquidate",
            amount_wei=breakdown["compensationWei"],
            gas_used=180_000,
            block_number=1_800_400 + fixture["loan_id"],
            description=(
                f"Liquidated overdue loan {fixture['loan_id']}"
                + (
                    f"; {validation.wei_to_eth(breakdown['badDebtWei'])} ETH written off as bad debt"
                    if breakdown["badDebtWei"]
                    else ""
                )
            ),
            loan_id=fixture["loan_id"],
            is_demo=True,
            created_at=settled,
        )

    elif status == "Cancelled":
        settled = now + (fixture["final_days"] or 0) * SECONDS_PER_DAY
        db.apply_cancel_to_pool(conn, refund_wei=collateral)
        tx_cancelled = demo_tx_hash(f"loan{fixture['loan_id']}:cancelled")
        db.insert_event(
            conn,
            loan_id=fixture["loan_id"],
            event_type="LoanCancelled",
            actor=borrower,
            amount_wei=collateral,
            block_number=1_800_500 + fixture["loan_id"],
            tx_hash=tx_cancelled,
            payload={"collateralRefundedWei": str(collateral), "demo": True},
            is_demo=True,
            created_at=settled,
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_cancelled,
            address=borrower,
            type_="loan_cancel",
            amount_wei=collateral,
            gas_used=60_000,
            block_number=1_800_500 + fixture["loan_id"],
            description=f"Cancelled the unfunded loan request {fixture['loan_id']}",
            loan_id=fixture["loan_id"],
            is_demo=True,
            created_at=settled,
        )


def check_consistency(conn) -> dict:
    """Offline sanity check on the indexed snapshot (see the module docstring)."""
    snapshot = db.pool_snapshot(conn)
    total_liquidity = int(snapshot["totalLiquidityWei"])
    reserved = int(snapshot["reservedLiquidityWei"])
    collateral = int(snapshot["accumulatedCollateralWei"])
    treasury = int(snapshot["treasuryBalanceWei"])

    loans, _ = db.list_loans(conn, limit=1000, offset=0)
    expected_reserved = sum(
        int(loan["principalWei"])
        for loan in loans
        if int(loan["statusCode"]) == validation.LOAN_STATUS_ACTIVE
    )
    expected_collateral = sum(
        int(loan["collateralWei"])
        for loan in loans
        if int(loan["statusCode"])
        in (validation.LOAN_STATUS_PENDING, validation.LOAN_STATUS_ACTIVE)
    )
    problems = []
    if reserved != expected_reserved:
        problems.append(
            f"reservedLiquidity {reserved} != sum of active principals {expected_reserved}"
        )
    if collateral != expected_collateral:
        problems.append(
            f"accumulatedCollateral {collateral} != locked collateral {expected_collateral}"
        )
    if reserved > total_liquidity:
        problems.append("reservedLiquidity exceeds totalLiquidity")
    if min(total_liquidity - reserved, collateral, treasury) < 0:
        problems.append("a pool claim went negative")

    return {
        "ok": not problems,
        "problems": problems,
        "visiblePoolBalanceWei": str((total_liquidity - reserved) + collateral + treasury),
        "availableLiquidityWei": snapshot["availableLiquidityWei"],
        "totalLiquidityWei": snapshot["totalLiquidityWei"],
        "reservedLiquidityWei": snapshot["reservedLiquidityWei"],
        "accumulatedCollateralWei": snapshot["accumulatedCollateralWei"],
        "treasuryBalanceWei": snapshot["treasuryBalanceWei"],
        "loanCount": len(loans),
    }
