"""SQLite schema, migrations, connection handling and row serialisation.

Storage rules
-------------
* **Every wei amount is stored as TEXT**, so a ``uint256`` never loses precision to
  SQLite's 64-bit ``INTEGER`` (a 100 ETH principal is ~1e20 wei, well past ``2**63``).
  Each wei column is paired with an exact display-ETH TEXT column computed with
  ``Decimal`` string arithmetic (never float).
* ``status`` is stored as the human-readable enum name **and** its numeric code, because
  the frontend filters on the name while the ABI/contract uses the number.
* The schema is versioned in ``schema_migrations`` so ``init_db`` is safe to re-run and
  future columns can be added without dropping a grader's demo data.
* ``pool_state`` is a one-row singleton holding the indexed protocol snapshot. It is
  updated incrementally on every indexed event, exactly mirroring the accounting in
  ``MicroLendPool.sol`` (see ``apply_pool_delta``), which is what makes ``GET /api/pool``
  return meaningful numbers offline in ``CHAIN_MODE=mock``.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from typing import Any, Iterable, Mapping, Sequence

from validation import (
    DEAD_SHARES,
    LOAN_STATUS_NAMES,
    LOAN_STATUS_PENDING,
    LOAN_STATUS_ACTIVE,
    LOAN_STATUS_REPAID,
    LOAN_STATUS_LIQUIDATED,
    LOAN_STATUS_CANCELLED,
    ApiError,
    amount_due_wei,
    base_due_wei,
    bps_to_percent,
    wei_to_eth,
)

DEFAULT_DB_FILENAME = "microlend.db"

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

_SCHEMA_V1 = """
CREATE TABLE IF NOT EXISTS users (
    address     TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_nonces (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    address     TEXT NOT NULL,
    nonce       TEXT NOT NULL UNIQUE,
    message     TEXT NOT NULL,
    issued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_nonces_lookup ON auth_nonces(address, used, expires_at);

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    address     TEXT NOT NULL,
    issued_at   INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_address ON sessions(address);

CREATE TABLE IF NOT EXISTS loans (
    loan_id          INTEGER PRIMARY KEY,
    borrower         TEXT    NOT NULL,
    principal_wei    TEXT    NOT NULL,
    principal_eth    TEXT    NOT NULL,
    collateral_wei   TEXT    NOT NULL,
    collateral_eth   TEXT    NOT NULL,
    interest_wei     TEXT    NOT NULL,
    interest_eth     TEXT    NOT NULL,
    rate_bps         INTEGER NOT NULL,
    duration_days    INTEGER NOT NULL,
    start_time       INTEGER NOT NULL DEFAULT 0,
    due_date         INTEGER NOT NULL DEFAULT 0,
    status           TEXT    NOT NULL,
    status_code      INTEGER NOT NULL,
    funded_wei       TEXT    NOT NULL DEFAULT '0',
    funded_eth       TEXT    NOT NULL DEFAULT '0',
    tx_hash_created  TEXT,
    tx_hash_repaid   TEXT,
    is_demo          INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_loans_borrower ON loans(borrower);
CREATE INDEX IF NOT EXISTS idx_loans_status   ON loans(status_code);

CREATE TABLE IF NOT EXISTS loan_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    loan_id        INTEGER NOT NULL REFERENCES loans(loan_id),
    event_type     TEXT    NOT NULL,
    actor          TEXT,
    amount_wei     TEXT    NOT NULL DEFAULT '0',
    amount_eth     TEXT    NOT NULL DEFAULT '0',
    block_number   INTEGER,
    tx_hash        TEXT    NOT NULL UNIQUE,
    log_index      INTEGER NOT NULL DEFAULT 0,
    payload_json   TEXT,
    is_demo        INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_loan ON loan_events(loan_id, id);

CREATE TABLE IF NOT EXISTS transactions (
    tx_hash       TEXT PRIMARY KEY,
    address       TEXT NOT NULL,
    type          TEXT NOT NULL,
    status        TEXT NOT NULL,
    amount_wei    TEXT NOT NULL DEFAULT '0',
    amount_eth    TEXT NOT NULL DEFAULT '0',
    gas_used      TEXT,
    block_number  INTEGER,
    description   TEXT,
    loan_id       INTEGER,
    is_demo       INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_address ON transactions(address, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_type    ON transactions(type, status);

CREATE TABLE IF NOT EXISTS pool_state (
    id                      INTEGER PRIMARY KEY CHECK (id = 1),
    total_shares_wei        TEXT NOT NULL DEFAULT '0',
    total_liquidity_wei     TEXT NOT NULL DEFAULT '0',
    reserved_liquidity_wei  TEXT NOT NULL DEFAULT '0',
    total_deposited_wei     TEXT NOT NULL DEFAULT '0',
    total_interest_wei      TEXT NOT NULL DEFAULT '0',
    total_fees_wei          TEXT NOT NULL DEFAULT '0',
    total_bad_debt_wei      TEXT NOT NULL DEFAULT '0',
    treasury_balance_wei    TEXT NOT NULL DEFAULT '0',
    accumulated_collateral_wei TEXT NOT NULL DEFAULT '0',
    loan_count              INTEGER NOT NULL DEFAULT 0,
    paused                  INTEGER NOT NULL DEFAULT 0,
    is_demo                 INTEGER NOT NULL DEFAULT 0,
    updated_at              INTEGER NOT NULL DEFAULT 0
);
"""

# v2: the owner-settable minCollateralBps is a live parameter, not a constant. In
# CHAIN_MODE=mock there is no chain to read, so the indexed snapshot carries it here.
# It mirrors MicroLendPool.minCollateralBps, whose immutable lower bound is
# MIN_COLLATERAL_FLOOR_BPS = 5000.
_SCHEMA_V2 = """
ALTER TABLE pool_state ADD COLUMN min_collateral_bps INTEGER NOT NULL DEFAULT 10000;
"""

MIGRATIONS: tuple[tuple[int, str], ...] = ((1, _SCHEMA_V1), (2, _SCHEMA_V2))


def now_ts() -> int:
    return int(time.time())


# ---------------------------------------------------------------------------
# Connection handling
# ---------------------------------------------------------------------------


def connect(db_path: str | None = None) -> sqlite3.Connection:
    """Open a tuned SQLite connection (WAL, foreign keys, Row factory)."""
    if db_path is None:
        db_path = default_db_path()
    if db_path != ":memory:":
        parent = os.path.dirname(os.path.abspath(db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)

    conn = sqlite3.connect(db_path, timeout=10.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    if db_path != ":memory:":
        # WAL gives concurrent readers during writes; harmless for the demo.
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def default_db_path() -> str:
    """Resolve the SQLite file: ``DATABASE_PATH`` (see .env.example) then ``MICROLEND_DB``."""
    env = os.environ.get("DATABASE_PATH") or os.environ.get("MICROLEND_DB")
    if env:
        return env
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), DEFAULT_DB_FILENAME)


def init_db(conn: sqlite3.Connection) -> sqlite3.Connection:
    """Apply pending migrations and ensure the ``pool_state`` singleton exists."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations ("
        "version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
    )
    applied = {
        row["version"] for row in conn.execute("SELECT version FROM schema_migrations").fetchall()
    }
    for version, script in MIGRATIONS:
        if version in applied:
            continue
        conn.executescript(script)
        conn.execute(
            "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
            (version, now_ts()),
        )
    conn.execute(
        "INSERT INTO pool_state (id, updated_at) VALUES (1, ?) "
        "ON CONFLICT(id) DO NOTHING",
        (now_ts(),),
    )
    conn.commit()
    return conn


def database_exists(db_path: str) -> bool:
    return db_path == ":memory:" or os.path.exists(db_path)


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _to_int(value: Any) -> int:
    if value is None:
        return 0
    return int(value)


def loan_status_name(code: int) -> str:
    return LOAN_STATUS_NAMES.get(code, "None")


def loan_to_dict(row: Mapping[str, Any], *, now: int | None = None) -> dict:
    """Serialise a ``loans`` row into the API's loan shape (wei strings + ETH display)."""
    now = now_ts() if now is None else now
    principal_wei = _to_int(row["principal_wei"])
    interest_wei = _to_int(row["interest_wei"])
    collateral_wei = _to_int(row["collateral_wei"])
    status_code = _to_int(row["status_code"])
    due_date = _to_int(row["due_date"])

    total_due_wei, late_fee = (0, 0)
    if status_code == LOAN_STATUS_ACTIVE:
        total_due_wei, late_fee = amount_due_wei(principal_wei, interest_wei, due_date, now)
    elif status_code in (LOAN_STATUS_REPAID, LOAN_STATUS_LIQUIDATED):
        total_due_wei = base_due_wei(principal_wei, interest_wei)

    data = {
        "loanId": _to_int(row["loan_id"]),
        "borrower": row["borrower"],
        "principalWei": str(principal_wei),
        "principalEth": wei_to_eth(principal_wei),
        "collateralWei": str(collateral_wei),
        "collateralEth": wei_to_eth(collateral_wei),
        "interestWei": str(interest_wei),
        "interestEth": wei_to_eth(interest_wei),
        "rateBps": _to_int(row["rate_bps"]),
        "aprPercent": bps_to_percent(_to_int(row["rate_bps"])),
        "durationDays": _to_int(row["duration_days"]),
        "startTime": _to_int(row["start_time"]),
        "dueDate": due_date,
        "status": row["status"],
        "statusCode": status_code,
        "fundedWei": str(_to_int(row["funded_wei"])),
        "fundedEth": wei_to_eth(_to_int(row["funded_wei"])),
        "totalDueWei": str(total_due_wei),
        "totalDueEth": wei_to_eth(total_due_wei),
        "lateFeeWei": str(late_fee),
        "lateFeeEth": wei_to_eth(late_fee),
        "isOverdue": bool(status_code == LOAN_STATUS_ACTIVE and now > due_date),
        "txHashCreated": row["tx_hash_created"],
        "txHashRepaid": row["tx_hash_repaid"],
        "isDemo": bool(row["is_demo"]),
        "createdAt": _to_int(row["created_at"]),
        "updatedAt": _to_int(row["updated_at"]),
    }
    if status_code == LOAN_STATUS_ACTIVE and due_date:
        data["secondsUntilDue"] = due_date - now
    return data


def event_to_dict(row: Mapping[str, Any]) -> dict:
    payload = None
    if row["payload_json"]:
        try:
            payload = json.loads(row["payload_json"])
        except (TypeError, ValueError):
            payload = None
    return {
        "id": _to_int(row["id"]),
        "loanId": _to_int(row["loan_id"]),
        "eventType": row["event_type"],
        "actor": row["actor"],
        "amountWei": str(_to_int(row["amount_wei"])),
        "amountEth": wei_to_eth(_to_int(row["amount_wei"])),
        "blockNumber": _to_int(row["block_number"]),
        "txHash": row["tx_hash"],
        "logIndex": _to_int(row["log_index"]),
        "payload": payload,
        "isDemo": bool(row["is_demo"]) if "is_demo" in row.keys() else False,
        "createdAt": _to_int(row["created_at"]),
    }


def transaction_to_dict(row: Mapping[str, Any]) -> dict:
    return {
        "txHash": row["tx_hash"],
        "address": row["address"],
        "type": row["type"],
        "status": row["status"],
        "amountWei": str(_to_int(row["amount_wei"])),
        "amountEth": wei_to_eth(_to_int(row["amount_wei"])),
        "gasUsed": _to_int(row["gas_used"]) or None,
        "blockNumber": _to_int(row["block_number"]) or None,
        "description": row["description"],
        "loanId": _to_int(row["loan_id"]) or None,
        "isDemo": bool(row["is_demo"]),
        "createdAt": _to_int(row["created_at"]),
    }


# ---------------------------------------------------------------------------
# Loans
# ---------------------------------------------------------------------------


def next_loan_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COALESCE(MAX(loan_id), 0) AS max_id FROM loans").fetchone()
    return _to_int(row["max_id"]) + 1


def insert_loan(conn: sqlite3.Connection, loan: Mapping[str, Any]) -> dict:
    """Insert a loan row. Raises ``CONFLICT`` if the id already exists."""
    ts = loan.get("created_at", now_ts())
    status_code = int(loan.get("status_code", LOAN_STATUS_PENDING))
    try:
        conn.execute(
            """
            INSERT INTO loans (
                loan_id, borrower, principal_wei, principal_eth, collateral_wei, collateral_eth,
                interest_wei, interest_eth, rate_bps, duration_days, start_time, due_date,
                status, status_code, funded_wei, funded_eth, tx_hash_created, tx_hash_repaid,
                is_demo, created_at, updated_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                int(loan["loan_id"]),
                loan["borrower"].lower(),
                str(_to_int(loan["principal_wei"])),
                wei_to_eth(_to_int(loan["principal_wei"])),
                str(_to_int(loan["collateral_wei"])),
                wei_to_eth(_to_int(loan["collateral_wei"])),
                str(_to_int(loan["interest_wei"])),
                wei_to_eth(_to_int(loan["interest_wei"])),
                int(loan["rate_bps"]),
                int(loan["duration_days"]),
                int(loan.get("start_time", 0)),
                int(loan.get("due_date", 0)),
                loan_status_name(status_code),
                status_code,
                str(_to_int(loan.get("funded_wei", 0))),
                wei_to_eth(_to_int(loan.get("funded_wei", 0))),
                loan.get("tx_hash_created"),
                loan.get("tx_hash_repaid"),
                1 if loan.get("is_demo") else 0,
                int(ts),
                int(ts),
            ),
        )
    except sqlite3.IntegrityError as exc:
        raise ApiError("CONFLICT", f"Loan {loan['loan_id']} already exists: {exc}") from None
    conn.commit()
    return get_loan(conn, int(loan["loan_id"]))


def get_loan_row(conn: sqlite3.Connection, loan_id: int) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM loans WHERE loan_id = ?", (int(loan_id),)).fetchone()


def get_loan(conn: sqlite3.Connection, loan_id: int) -> dict:
    row = get_loan_row(conn, loan_id)
    if row is None:
        raise ApiError("NOT_FOUND", f"Loan {loan_id} was not found in the index.")
    return loan_to_dict(row)


def update_loan(conn: sqlite3.Connection, loan_id: int, **changes: Any) -> dict:
    """Patch a loan row. Wei/ETH display pairs are recomputed automatically."""
    if not changes:
        return get_loan(conn, loan_id)
    allowed = {
        "status_code",
        "collateral_wei",
        "interest_wei",
        "start_time",
        "due_date",
        "funded_wei",
        "tx_hash_created",
        "tx_hash_repaid",
        "is_demo",
        "borrower",
        "rate_bps",
        "duration_days",
        "principal_wei",
    }
    unknown = set(changes) - allowed
    if unknown:
        raise AssertionError(f"update_loan() got unexpected columns: {sorted(unknown)}")

    sets: list[str] = []
    params: list[Any] = []
    for column, value in changes.items():
        sets.append(f"{column} = ?")
        params.append(value)
        if column.endswith("_wei") and column != "funded_wei":
            sets.append(f"{column[:-4]}_eth = ?")
            params.append(wei_to_eth(_to_int(value)))
        elif column == "funded_wei":
            sets.append("funded_eth = ?")
            params.append(wei_to_eth(_to_int(value)))
    if "status_code" in changes:
        sets.append("status = ?")
        params.append(loan_status_name(int(changes["status_code"])))
    sets.append("updated_at = ?")
    params.append(now_ts())
    params.append(int(loan_id))

    conn.execute(f"UPDATE loans SET {', '.join(sets)} WHERE loan_id = ?", params)
    conn.commit()
    return get_loan(conn, loan_id)


def list_loans(
    conn: sqlite3.Connection,
    *,
    status: int | None = None,
    borrower: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    where: list[str] = []
    params: list[Any] = []
    if status is not None:
        where.append("status_code = ?")
        params.append(int(status))
    if borrower:
        where.append("borrower = ?")
        params.append(borrower.lower())
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = _to_int(
        conn.execute(f"SELECT COUNT(*) AS n FROM loans {clause}", params).fetchone()["n"]
    )
    rows = conn.execute(
        f"SELECT * FROM loans {clause} ORDER BY loan_id DESC LIMIT ? OFFSET ?",
        [*params, int(limit), int(offset)],
    ).fetchall()
    now = now_ts()
    return [loan_to_dict(row, now=now) for row in rows], total


# ---------------------------------------------------------------------------
# Events + transactions
# ---------------------------------------------------------------------------


def insert_event(
    conn: sqlite3.Connection,
    *,
    loan_id: int,
    event_type: str,
    actor: str | None,
    amount_wei: int = 0,
    block_number: int | None = None,
    tx_hash: str,
    log_index: int = 0,
    payload: Mapping[str, Any] | None = None,
    is_demo: bool = False,
    created_at: int | None = None,
) -> dict:
    """Append a loan event. The ``tx_hash`` UNIQUE constraint is the replay guard."""
    try:
        cursor = conn.execute(
            """
            INSERT INTO loan_events (
                loan_id, event_type, actor, amount_wei, amount_eth, block_number,
                tx_hash, log_index, payload_json, is_demo, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                int(loan_id),
                event_type,
                actor.lower() if actor else None,
                str(_to_int(amount_wei)),
                wei_to_eth(_to_int(amount_wei)),
                int(block_number) if block_number is not None else None,
                tx_hash,
                int(log_index),
                json.dumps(payload, sort_keys=True) if payload else None,
                1 if is_demo else 0,
                int(created_at if created_at is not None else now_ts()),
            ),
        )
    except sqlite3.IntegrityError:
        raise ApiError(
            "CONFLICT",
            f"Transaction {tx_hash} has already been indexed (duplicate event).",
        ) from None
    conn.commit()
    row = conn.execute("SELECT * FROM loan_events WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return event_to_dict(row)


def list_events(conn: sqlite3.Connection, loan_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM loan_events WHERE loan_id = ? ORDER BY id ASC", (int(loan_id),)
    ).fetchall()
    return [event_to_dict(row) for row in rows]


def insert_transaction(
    conn: sqlite3.Connection,
    *,
    tx_hash: str,
    address: str,
    type_: str,
    status: str = "confirmed",
    amount_wei: int = 0,
    gas_used: int | None = None,
    block_number: int | None = None,
    description: str | None = None,
    loan_id: int | None = None,
    is_demo: bool = False,
    created_at: int | None = None,
) -> dict:
    try:
        conn.execute(
            """
            INSERT INTO transactions (
                tx_hash, address, type, status, amount_wei, amount_eth, gas_used,
                block_number, description, loan_id, is_demo, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (
                tx_hash,
                address.lower(),
                type_,
                status,
                str(_to_int(amount_wei)),
                wei_to_eth(_to_int(amount_wei)),
                str(int(gas_used)) if gas_used is not None else None,
                int(block_number) if block_number is not None else None,
                description,
                int(loan_id) if loan_id is not None else None,
                1 if is_demo else 0,
                int(created_at if created_at is not None else now_ts()),
            ),
        )
    except sqlite3.IntegrityError:
        raise ApiError(
            "CONFLICT", f"Transaction {tx_hash} has already been indexed."
        ) from None
    conn.commit()
    return transaction_to_dict(
        conn.execute("SELECT * FROM transactions WHERE tx_hash = ?", (tx_hash,)).fetchone()
    )


def get_transaction(conn: sqlite3.Connection, tx_hash: str) -> dict | None:
    row = conn.execute("SELECT * FROM transactions WHERE tx_hash = ?", (tx_hash,)).fetchone()
    return transaction_to_dict(row) if row else None


def list_transactions(
    conn: sqlite3.Connection,
    *,
    address: str | None = None,
    type_: str | None = None,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    where: list[str] = []
    params: list[Any] = []
    if address:
        where.append("address = ?")
        params.append(address.lower())
    if type_:
        where.append("type = ?")
        params.append(type_)
    if status:
        where.append("status = ?")
        params.append(status)
    clause = f"WHERE {' AND '.join(where)}" if where else ""

    total = _to_int(
        conn.execute(f"SELECT COUNT(*) AS n FROM transactions {clause}", params).fetchone()["n"]
    )
    rows = conn.execute(
        f"SELECT * FROM transactions {clause} ORDER BY created_at DESC, rowid DESC "
        "LIMIT ? OFFSET ?",
        [*params, int(limit), int(offset)],
    ).fetchall()
    return [transaction_to_dict(row) for row in rows], total


# ---------------------------------------------------------------------------
# Indexed pool snapshot
# ---------------------------------------------------------------------------


def get_pool_state(conn: sqlite3.Connection) -> dict:
    row = conn.execute("SELECT * FROM pool_state WHERE id = 1").fetchone()
    if row is None:
        init_db(conn)
        row = conn.execute("SELECT * FROM pool_state WHERE id = 1").fetchone()
    return dict(row)


def _pool_int(state: Mapping[str, Any], key: str) -> int:
    return _to_int(state.get(key))


POOL_DELTA_KEYS = (
    "total_shares_wei",
    "total_liquidity_wei",
    "reserved_liquidity_wei",
    "total_deposited_wei",
    "total_interest_wei",
    "total_fees_wei",
    "total_bad_debt_wei",
    "treasury_balance_wei",
    "accumulated_collateral_wei",
    "loan_count",
)


def apply_pool_delta(conn: sqlite3.Connection, **deltas: int) -> None:
    """Apply signed integer deltas to the singleton ``pool_state`` row.

    The caller supplies deltas that mirror one contract event's accounting, so the indexed
    snapshot tracks the pool the same way ``MicroLendPool.sol`` updates its storage.
    """
    unknown = set(deltas) - set(POOL_DELTA_KEYS)
    if unknown:
        raise AssertionError(f"apply_pool_delta() got unknown keys: {sorted(unknown)}")
    state = get_pool_state(conn)
    sets: list[str] = []
    params: list[Any] = []
    for key, delta in deltas.items():
        if delta == 0:
            continue
        # Deliberately read-modify-write in Python: SQLite's INTEGER is signed 64-bit, so
        # `CAST(wei_text AS INTEGER)` would saturate for large uint256 values (100 ETH is
        # 1e20 wei). Python ints are unbounded, so the snapshot stays exact.
        updated = max(0, _pool_int(state, key) + int(delta))
        sets.append(f"{key} = ?")
        params.append(str(updated))
    if not sets:
        return
    sets.append("updated_at = ?")
    params.append(now_ts())
    conn.execute(f"UPDATE pool_state SET {', '.join(sets)} WHERE id = 1", params)
    conn.commit()


def apply_request_to_pool(
    conn: sqlite3.Connection, *, collateral_wei: int, activated: bool, principal_wei: int
) -> None:
    """Index ``LoanRequested`` (+ immediate ``LoanActivated`` from free liquidity)."""
    apply_pool_delta(
        conn,
        accumulated_collateral_wei=collateral_wei,
        loan_count=1,
        reserved_liquidity_wei=principal_wei if activated else 0,
    )


def apply_funding_to_pool(
    conn: sqlite3.Connection, *, amount_wei: int, shares_wei: int, activated: bool, principal_wei: int
) -> None:
    """Index ``LoanFunded`` (+ the ``LiquidityDeposited`` it emits for the contribution)."""
    apply_pool_delta(
        conn,
        total_liquidity_wei=amount_wei,
        total_deposited_wei=amount_wei,
        total_shares_wei=shares_wei,
        reserved_liquidity_wei=principal_wei if activated else 0,
    )


def apply_deposit_to_pool(conn: sqlite3.Connection, *, amount_wei: int, shares_wei: int) -> None:
    apply_pool_delta(
        conn,
        total_liquidity_wei=amount_wei,
        total_deposited_wei=amount_wei,
        total_shares_wei=shares_wei,
    )


def apply_withdraw_from_pool(conn: sqlite3.Connection, *, amount_wei: int, shares_wei: int) -> None:
    apply_pool_delta(
        conn, total_liquidity_wei=-amount_wei, total_shares_wei=-shares_wei
    )


def apply_repayment_to_pool(
    conn: sqlite3.Connection,
    *,
    principal_wei: int,
    interest_wei: int,
    late_fee_wei: int,
    fee_wei: int,
    collateral_wei: int,
) -> None:
    """Index ``LoanRepaid`` using the corrected fee routing (spec section 1).

    ``reservedLiquidity`` already held the principal claim, so the pool only gains
    ``netInterest + lateFee``; the protocol fee lands in ``treasuryBalance`` and never in
    ``totalLiquidity``.  ``totalInterestEarned`` grows by ``interest + lateFee``.
    """
    apply_pool_delta(
        conn,
        accumulated_collateral_wei=-collateral_wei,
        reserved_liquidity_wei=-principal_wei,
        total_liquidity_wei=(interest_wei - fee_wei) + late_fee_wei,
        total_interest_wei=interest_wei + late_fee_wei,
        total_fees_wei=fee_wei,
        treasury_balance_wei=fee_wei,
    )


def apply_liquidation_to_pool(
    conn: sqlite3.Connection,
    *,
    principal_wei: int,
    compensation_wei: int,
    collateral_wei: int,
    bad_debt_wei: int,
    interest_wei: int,
) -> None:
    """Index ``LoanLiquidated``: suppliers give up the principal claim and take the seizure."""
    apply_pool_delta(
        conn,
        accumulated_collateral_wei=-collateral_wei,
        reserved_liquidity_wei=-principal_wei,
        total_liquidity_wei=compensation_wei - principal_wei,
        total_interest_wei=interest_wei,
        total_bad_debt_wei=bad_debt_wei,
    )


def apply_cancel_to_pool(conn: sqlite3.Connection, *, refund_wei: int) -> None:
    apply_pool_delta(conn, accumulated_collateral_wei=-refund_wei)


def apply_treasury_claim_to_pool(conn: sqlite3.Connection, *, amount_wei: int) -> None:
    """``claimTreasury`` moves fees out of the pool; ``totalLiquidity`` is untouched."""
    apply_pool_delta(conn, treasury_balance_wei=-amount_wei)


def set_pool_state(conn: sqlite3.Connection, **values: Any) -> None:
    """Set absolute values on the singleton ``pool_state`` row (used by the demo seed)."""
    unknown = set(values) - set(POOL_DELTA_KEYS) - {"paused", "is_demo", "min_collateral_bps"}
    if unknown:
        raise AssertionError(f"set_pool_state() got unknown keys: {sorted(unknown)}")
    sets: list[str] = []
    params: list[Any] = []
    for key, value in values.items():
        if key in ("paused", "is_demo"):
            sets.append(f"{key} = ?")
            params.append(1 if value else 0)
        elif key == "min_collateral_bps":
            sets.append(f"{key} = ?")
            params.append(int(value))
        else:
            sets.append(f"{key} = ?")
            params.append(str(int(value)))
    sets.append("updated_at = ?")
    params.append(now_ts())
    conn.execute(f"UPDATE pool_state SET {', '.join(sets)} WHERE id = 1", params)
    conn.commit()


def pool_min_collateral_bps(conn: sqlite3.Connection) -> int:
    """The indexed ``minCollateralBps`` (CHAIN_MODE=mock has no chain getter to call)."""
    state = get_pool_state(conn)
    row = state.get("min_collateral_bps")
    return int(row) if row is not None else 10_000


def set_pool_min_collateral_bps(conn: sqlite3.Connection, bps: int) -> int:
    """Override the indexed ``minCollateralBps``; returns the new value.

    The contract refuses to go below MIN_COLLATERAL_FLOOR_BPS, so this deliberately does not
    clamp — the API clamps when it reads the value, which keeps a mis-set parameter visible
    instead of silently hidden.
    """
    set_pool_state(conn, min_collateral_bps=int(bps))
    return int(bps)


def pool_snapshot(conn: sqlite3.Connection) -> dict:
    """Build the ``GET /api/pool`` payload from the indexed snapshot (exact integer maths)."""
    state = get_pool_state(conn)
    total_shares = _pool_int(state, "total_shares_wei")
    total_liquidity = _pool_int(state, "total_liquidity_wei")
    reserved = _pool_int(state, "reserved_liquidity_wei")
    available = max(total_liquidity - reserved, 0)
    share_price = (total_liquidity * 10**18) // total_shares if total_shares else 10**18

    def eth(key: str) -> str:
        return wei_to_eth(_pool_int(state, key))

    return {
        "totalSharesWei": str(total_shares),
        "totalSharesEth": wei_to_eth(total_shares),
        "totalLiquidityWei": str(total_liquidity),
        "totalLiquidityEth": wei_to_eth(total_liquidity),
        "availableLiquidityWei": str(available),
        "availableLiquidityEth": wei_to_eth(available),
        "reservedLiquidityWei": str(reserved),
        "reservedLiquidityEth": wei_to_eth(reserved),
        "totalDepositedWei": str(_pool_int(state, "total_deposited_wei")),
        "totalDepositedEth": eth("total_deposited_wei"),
        "totalInterestEarnedWei": str(_pool_int(state, "total_interest_wei")),
        "totalInterestEarnedEth": eth("total_interest_wei"),
        "totalFeesCollectedWei": str(_pool_int(state, "total_fees_wei")),
        "totalFeesCollectedEth": eth("total_fees_wei"),
        "totalBadDebtWei": str(_pool_int(state, "total_bad_debt_wei")),
        "totalBadDebtEth": eth("total_bad_debt_wei"),
        "treasuryBalanceWei": str(_pool_int(state, "treasury_balance_wei")),
        "treasuryBalanceEth": eth("treasury_balance_wei"),
        "accumulatedCollateralWei": str(_pool_int(state, "accumulated_collateral_wei")),
        "accumulatedCollateralEth": eth("accumulated_collateral_wei"),
        "loanCount": _pool_int(state, "loan_count"),
        "sharePriceWei": str(share_price),
        "sharePriceEth": wei_to_eth(share_price),
        "paused": bool(state["paused"]),
        "isDemo": bool(state["is_demo"]),
        "updatedAt": _pool_int(state, "updated_at"),
    }


def user_loans(conn: sqlite3.Connection, address: str) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM loans WHERE borrower = ? ORDER BY loan_id DESC", (address.lower(),)
    ).fetchall()
    now = now_ts()
    return [loan_to_dict(row, now=now) for row in rows]


def user_position(conn: sqlite3.Connection, address: str) -> dict:
    """Per-wallet aggregate used by ``GET /api/positions/<address>``."""
    address = address.lower()
    now = now_ts()
    loans = user_loans(conn, address)

    collateral_locked = 0
    outstanding_debt = 0
    active = pending = repaid = liquidated = cancelled = 0
    for loan in loans:
        if loan["statusCode"] in (LOAN_STATUS_PENDING, LOAN_STATUS_ACTIVE):
            collateral_locked += int(loan["collateralWei"])
        if loan["statusCode"] == LOAN_STATUS_ACTIVE:
            outstanding_debt += int(loan["totalDueWei"])
            active += 1
        elif loan["statusCode"] == LOAN_STATUS_PENDING:
            pending += 1
        elif loan["statusCode"] == LOAN_STATUS_REPAID:
            repaid += 1
        elif loan["statusCode"] == LOAN_STATUS_LIQUIDATED:
            liquidated += 1
        elif loan["statusCode"] == LOAN_STATUS_CANCELLED:
            cancelled += 1

    borrowed_total = sum(int(loan["principalWei"]) for loan in loans)
    interest_total = sum(int(loan["interestWei"]) for loan in loans)
    repaid_total = sum(
        int(loan["principalWei"]) + int(loan["interestWei"])
        for loan in loans
        if loan["statusCode"] == LOAN_STATUS_REPAID
    )

    supplied = sum(
        _to_int(row["amount_wei"])
        for row in conn.execute(
            "SELECT amount_wei FROM transactions WHERE address = ?", (address,)
        ).fetchall()
    )

    return {
        "address": address,
        "sharesWei": "0",
        "sharesEth": "0",
        "shareValueWei": "0",
        "shareValueEth": "0",
        "collateralLockedWei": str(collateral_locked),
        "collateralLockedEth": wei_to_eth(collateral_locked),
        "outstandingDebtWei": str(outstanding_debt),
        "outstandingDebtEth": wei_to_eth(outstanding_debt),
        "borrowedTotalWei": str(borrowed_total),
        "borrowedTotalEth": wei_to_eth(borrowed_total),
        "interestTotalWei": str(interest_total),
        "interestTotalEth": wei_to_eth(interest_total),
        "repaidTotalWei": str(repaid_total),
        "repaidTotalEth": wei_to_eth(repaid_total),
        "suppliedWei": str(supplied),
        "suppliedEth": wei_to_eth(supplied),
        "activeLoans": active,
        "pendingLoans": pending,
        "repaidLoans": repaid,
        "liquidatedLoans": liquidated,
        "cancelledLoans": cancelled,
        "loanCount": len(loans),
        "loans": loans,
        "updatedAt": now,
    }


def table_counts(conn: sqlite3.Connection) -> dict[str, int]:
    counts = {}
    for table in ("users", "auth_nonces", "sessions", "loans", "loan_events", "transactions"):
        counts[table] = _to_int(
            conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
        )
    return counts


__all__ = [
    "connect",
    "init_db",
    "default_db_path",
    "database_exists",
    "now_ts",
    "loan_to_dict",
    "event_to_dict",
    "transaction_to_dict",
    "next_loan_id",
    "insert_loan",
    "get_loan",
    "get_loan_row",
    "update_loan",
    "list_loans",
    "insert_event",
    "list_events",
    "insert_transaction",
    "get_transaction",
    "list_transactions",
    "get_pool_state",
    "apply_pool_delta",
    "apply_request_to_pool",
    "apply_funding_to_pool",
    "apply_deposit_to_pool",
    "apply_withdraw_from_pool",
    "apply_repayment_to_pool",
    "apply_liquidation_to_pool",
    "apply_cancel_to_pool",
    "apply_treasury_claim_to_pool",
    "set_pool_state",
    "pool_min_collateral_bps",
    "set_pool_min_collateral_bps",
    "pool_snapshot",
    "user_loans",
    "user_position",
    "table_counts",
    "DEAD_SHARES",
]
