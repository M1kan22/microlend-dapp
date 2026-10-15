"""Seed / reset the MicroLend SQLite index.

Usage::

    python backend/seed.py                 # seed only when the database is empty
    python backend/seed.py --reset         # wipe indexed rows and re-seed
    python backend/seed.py --db path.db    # explicit database file
    python backend/seed.py --check         # verify the indexed snapshot is consistent
    python backend/seed.py --json          # machine-readable summary

Environment: ``DATABASE_PATH`` (default ``backend/microlend.db``) is honoured so the CLI
seeds the same file the Flask app uses.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

import db  # noqa: E402
import demo_seed  # noqa: E402


def seed_database(db_path: str | None = None, *, reset: bool = False) -> dict:
    """Seed ``db_path`` (or the configured path) and return a summary dict."""
    conn = db.init_db(db.connect(db_path or db.default_db_path()))
    try:
        summary = demo_seed.ensure_seed(conn, force=reset)
        summary["consistency"] = demo_seed.check_consistency(conn)
        summary["database"] = db_path or db.default_db_path()
        return summary
    finally:
        conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed the MicroLend demo index.")
    parser.add_argument("--db", dest="db_path", default=None, help="SQLite file path")
    parser.add_argument(
        "--reset", action="store_true", help="delete indexed rows and re-seed"
    )
    parser.add_argument("--check", action="store_true", help="only verify consistency")
    parser.add_argument("--json", action="store_true", help="print JSON output")
    args = parser.parse_args(argv)

    if args.check:
        conn = db.init_db(db.connect(args.db_path or db.default_db_path()))
        try:
            report = demo_seed.check_consistency(conn)
        finally:
            conn.close()
        print(json.dumps(report, indent=2) if args.json else _format_consistency(report))
        return 0 if report["ok"] else 1

    summary = seed_database(args.db_path, reset=args.reset)
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        print(_format_summary(summary))
    return 0 if summary["consistency"]["ok"] else 1


def _format_summary(summary: dict) -> str:
    lines = [
        f"database   : {summary['database']}",
        f"seeded     : {summary['seeded']}"
        + ("" if summary["seeded"] else f" ({summary.get('reason', 'already populated')})"),
    ]
    if summary["seeded"]:
        pool = summary["pool"]
        lines += [
            f"loans      : {summary['loans']} ({summary['activeLoans']} active)",
            f"transactions: {summary['transactions']}",
            f"deposited  : {pool['totalDepositedEth']} ETH",
            f"liquidity  : {pool['totalLiquidityEth']} ETH "
            f"(available {pool['availableLiquidityEth']} ETH, reserved "
            f"{pool['reservedLiquidityEth']} ETH)",
            f"collateral : {pool['accumulatedCollateralEth']} ETH",
            f"treasury   : {pool['treasuryBalanceEth']} ETH",
            f"bad debt   : {pool['totalBadDebtEth']} ETH",
        ]
    lines.append(_format_consistency(summary["consistency"]))
    return "\n".join(lines)


def _format_consistency(report: dict) -> str:
    status = "OK" if report["ok"] else "PROBLEMS: " + "; ".join(report["problems"])
    return (
        "consistency: "
        f"{status}\n"
        f"  visible pool balance : {report['visiblePoolBalanceWei']} wei\n"
        f"  totalLiquidity       : {report['totalLiquidityWei']} wei\n"
        f"  reservedLiquidity    : {report['reservedLiquidityWei']} wei\n"
        f"  accumulatedCollateral: {report['accumulatedCollateralWei']} wei\n"
        f"  treasuryBalance      : {report['treasuryBalanceWei']} wei"
    )


if __name__ == "__main__":
    sys.exit(main())
