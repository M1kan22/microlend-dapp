"""Pure validation + money-math helpers.

Design rules (see docs/INTEGRATION_SPEC.md sections 2 and 3):

* **All ETH amounts arrive as exact decimal strings** (``"0.05"``, ``"1"``, ``".5"``).
  Floats and JSON numbers are *rejected*: binary floating point cannot represent 0.1
  exactly, so accepting it would silently corrupt wei amounts.
* **All money arithmetic uses ``decimal.Decimal`` with integer wei**, never ``float``.
  ``Decimal`` scale is capped at 18 so every accepted amount maps to an exact integer
  number of wei.
* The on-chain limits in ``contracts/MicroLendPool.sol`` are mirrored here so the API
  rejects a bad request with ``400 VALIDATION_ERROR`` *before* a wallet is asked to pay
  gas for a transaction that would revert.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Mapping

# ---------------------------------------------------------------------------
# Protocol constants — mirror contracts/MicroLendPool.sol and spec section 2.1
# ---------------------------------------------------------------------------

WEI_PER_ETH = 10**18
BPS_DENOMINATOR = 10_000
DAYS_PER_YEAR = 365

MIN_DEPOSIT_WEI = 10**12                # contract default minDeposit        (0.000001 ETH)
MIN_LOAN_PRINCIPAL_WEI = 10**13         # contract default minLoanPrincipal  (0.00001 ETH)
MAX_LOAN_PRINCIPAL_WEI = 100 * WEI_PER_ETH   # contract default maxLoanPrincipal (100 ETH)
MAX_DURATION_DAYS = 365                 # contract default maxDurationDays
MAX_RATE_BPS = 5_000                    # contract default maxRateBps (50% APR)
# The contract's *initial* minCollateralBps is 10_000 (100% of principal), but it is
# owner-settable and the live value must be read from the chain (see collateral_requirement).
# Use this constant only as the default when no live value is available.
DEFAULT_MIN_COLLATERAL_BPS = 10_000
MIN_COLLATERAL_BPS = DEFAULT_MIN_COLLATERAL_BPS  # alias kept for readability at call sites
# Hard, immutable lower bound from the contract: the owner can never set a requirement below
# 50% of principal. No caller may ever accept collateral that violates this floor.
MIN_COLLATERAL_FLOOR_BPS = 5_000        # contract MIN_COLLATERAL_FLOOR_BPS (immutable)
FEE_BPS = 1_000                         # contract default feeBps   (10% of interest)
PENALTY_BPS = 500                       # contract default penaltyBps (5%)
LATE_FEE_BPS = 100                      # contract default lateFeeBps (1% per 30 days)
MAX_FEE_BPS = 2_000
MAX_PENALTY_BPS = 2_000
MAX_LATE_FEE_BPS = 2_000
LATE_PERIOD_SECONDS = 30 * 24 * 60 * 60
DEAD_SHARES = 1

# uint256 headroom: reject anything that cannot be a uint256.
UINT256_MAX = 2**256 - 1

# Pagination
DEFAULT_LIMIT = 50
MAX_LIMIT = 200

# LoanStatus enum (spec section 2.5 / 2.2)
LOAN_STATUS_NONE = 0
LOAN_STATUS_PENDING = 1
LOAN_STATUS_ACTIVE = 2
LOAN_STATUS_REPAID = 3
LOAN_STATUS_LIQUIDATED = 4
LOAN_STATUS_CANCELLED = 5

LOAN_STATUS_NAMES = {
    LOAN_STATUS_NONE: "None",
    LOAN_STATUS_PENDING: "Pending",
    LOAN_STATUS_ACTIVE: "Active",
    LOAN_STATUS_REPAID: "Repaid",
    LOAN_STATUS_LIQUIDATED: "Liquidated",
    LOAN_STATUS_CANCELLED: "Cancelled",
}

STATUS_TO_CODE = {name.lower(): code for code, name in LOAN_STATUS_NAMES.items()}

# ---------------------------------------------------------------------------
# Errors / envelope error codes (spec section 3)
# ---------------------------------------------------------------------------

ERROR_CODES = (
    "VALIDATION_ERROR",
    "AUTH_REQUIRED",
    "AUTH_INVALID",
    "NOT_FOUND",
    "CONFLICT",
    "UPSTREAM_ERROR",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
)

_DEFAULT_STATUS = {
    "VALIDATION_ERROR": 400,
    "AUTH_REQUIRED": 401,
    "AUTH_INVALID": 401,
    "NOT_FOUND": 404,
    "CONFLICT": 409,
    "UPSTREAM_ERROR": 502,
    "RATE_LIMITED": 429,
    "INTERNAL_ERROR": 500,
}


class ApiError(Exception):
    """Transport-level error carrying an envelope ``code`` and HTTP status."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int | None = None,
        fields: Mapping[str, Any] | None = None,
    ) -> None:
        if code not in ERROR_CODES:
            raise AssertionError(f"unknown API error code {code!r}")
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status if status is not None else _DEFAULT_STATUS[code]
        self.fields = dict(fields or {})

    def to_dict(self) -> dict:
        return {"code": self.code, "message": self.message, "fields": self.fields}


class ValidationError(ApiError):
    """Field-level validation failure; ``fields`` maps field name -> message."""

    def __init__(self, fields: Mapping[str, Any] | str, message: str | None = None) -> None:
        if isinstance(fields, str):
            fields = {"_request": fields}
        super().__init__(
            "VALIDATION_ERROR",
            message or "One or more fields are invalid.",
            400,
            fields,
        )


def _field_error(field: str, message: str) -> ValidationError:
    return ValidationError({field: message})


# ---------------------------------------------------------------------------
# Decimal helpers — the only money conversions in the backend
# ---------------------------------------------------------------------------

# An "exact decimal ETH string": no sign, no exponent, at least one digit.
_ETH_STRING_RE = re.compile(r"^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$")
_MAX_DECIMALS = 18


def parse_eth_decimal(value: Any, field: str = "amount") -> Decimal:
    """Parse an exact decimal ETH string into ``Decimal``.

    Rejects (all with a field-level ``VALIDATION_ERROR``):

    * ``float`` / ``bool`` — binary floating point is never allowed on a money path;
    * JSON numbers / other types — the API contract is string-only so the client cannot
      smuggle in a value that already lost precision;
    * ``"1e-18"``, ``"-1"``, ``"+1"``, ``""``, ``" "``, ``"0x10"``, ``"1.2.3"`` — not
      exact decimal notation;
    * more than 18 decimal places — unrepresentable in wei.
    """
    if isinstance(value, bool):
        raise _field_error(field, "must be an ETH decimal string, not a boolean")
    if isinstance(value, float):
        raise _field_error(
            field,
            "must be an ETH decimal string; floats are rejected because binary floating "
            "point cannot represent ETH amounts exactly",
        )
    if not isinstance(value, str):
        raise _field_error(
            field,
            f"must be an ETH decimal string (got {type(value).__name__}); "
            'send amounts as JSON strings such as "0.05"',
        )

    text = value.strip()
    if not text:
        raise _field_error(field, "must not be empty")
    if not _ETH_STRING_RE.match(text):
        raise _field_error(
            field,
            "must be an exact decimal ETH string (no sign, no exponent), e.g. \"0.05\"",
        )

    try:
        amount = Decimal(text)
    except InvalidOperation:  # pragma: no cover - regex already guarantees this
        raise _field_error(field, "is not a valid decimal number") from None

    exponent = amount.as_tuple().exponent
    if isinstance(exponent, int) and exponent < -_MAX_DECIMALS:
        raise _field_error(field, f"has more than {_MAX_DECIMALS} decimal places")
    if not amount.is_finite():
        raise _field_error(field, "must be a finite number")
    if amount < 0:
        raise _field_error(field, "must not be negative")
    return amount


def eth_to_wei(value: Any, field: str = "amount") -> int:
    """Exact decimal ETH string -> integer wei (no float anywhere)."""
    amount = parse_eth_decimal(value, field)
    scaled = amount.scaleb(_MAX_DECIMALS)
    if scaled != scaled.to_integral_value():
        # Cannot happen once the exponent check passes, but never round silently.
        raise _field_error(field, "cannot be represented exactly in wei")
    wei = int(scaled)
    _check_uint256(wei, field)
    return wei


def wei_to_eth(wei: int) -> str:
    """Integer wei -> shortest exact decimal ETH string (pure integer arithmetic)."""
    wei = _as_int(wei)
    negative = wei < 0
    wei = abs(wei)
    whole, fraction = divmod(wei, WEI_PER_ETH)
    sign = "-" if negative else ""
    if fraction == 0:
        return f"{sign}{whole}"
    return f"{sign}{whole}.{fraction:018d}".rstrip("0")


def bps_to_percent(bps: int) -> str:
    """Basis points -> exact percentage string (``500`` -> ``"5"``, ``125`` -> ``"1.25"``)."""
    bps = _as_int(bps)
    whole, fraction = divmod(bps, 100)
    if fraction == 0:
        return str(whole)
    return f"{whole}.{fraction:02d}".rstrip("0")


def _as_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError(f"expected int, got {type(value).__name__}")
    return value


def _check_uint256(wei: int, field: str) -> None:
    if wei > UINT256_MAX:
        raise _field_error(field, "exceeds the uint256 range")


# ---------------------------------------------------------------------------
# Integers (rates, durations)
# ---------------------------------------------------------------------------


def parse_int(value: Any, field: str) -> int:
    """Strict integer parse. Rejects ``bool`` and ``float`` (``1.0`` is not an integer)."""
    if isinstance(value, bool):
        raise _field_error(field, "must be an integer, not a boolean")
    if isinstance(value, float):
        raise _field_error(field, "must be an integer, not a float")
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        text = value.strip()
        if not re.match(r"^[0-9]+$", text):
            raise _field_error(field, "must be a non-negative integer")
        return int(text)
    raise _field_error(field, "must be an integer")


# ---------------------------------------------------------------------------
# Addresses
# ---------------------------------------------------------------------------

_ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
ZERO_ADDRESS = "0x" + "0" * 40


def is_address(value: Any) -> bool:
    return isinstance(value, str) and bool(_ADDRESS_RE.match(value))


def to_checksum_address(address: str) -> str:
    """EIP-55 mixed-case checksum encoding (uses the vendored Keccak-256)."""
    from keccak import keccak256  # local import keeps this module import-light

    if not is_address(address):
        raise _field_error("address", "must be a 20-byte hex address (0x + 40 hex chars)")
    body = address[2:].lower()
    digest = keccak256(body.encode("ascii")).hex()
    out = []
    for index, char in enumerate(body):
        if char in "0123456789":
            out.append(char)
        elif int(digest[index], 16) >= 8:
            out.append(char.upper())
        else:
            out.append(char)
    return "0x" + "".join(out)


def validate_address(value: Any, field: str = "address", *, allow_zero: bool = False) -> str:
    """Validate an address, enforce the EIP-55 checksum when mixed case, return checksum form."""
    if not isinstance(value, str):
        raise _field_error(field, "must be a hex address string")
    if not _ADDRESS_RE.match(value):
        raise _field_error(field, "must be a 20-byte hex address (0x + 40 hex characters)")
    body = value[2:]
    if body != body.lower() and body != body.upper():
        # Mixed case carries a checksum intent, so verify it.
        if to_checksum_address(value) != value:
            raise _field_error(field, "has an invalid EIP-55 checksum")
    if not allow_zero and value.lower() == ZERO_ADDRESS:
        raise _field_error(field, "must not be the zero address")
    return to_checksum_address(value)


def addresses_equal(left: str | None, right: str | None) -> bool:
    if not isinstance(left, str) or not isinstance(right, str):
        return False
    return left.lower() == right.lower()


# ---------------------------------------------------------------------------
# Money + protocol limits (mirror MicroLendPool.sol)
# ---------------------------------------------------------------------------


def validate_principal_wei(wei: int, field: str = "principalEth") -> int:
    """Mirror requestLoan: principal >= minLoanPrincipal && <= maxLoanPrincipal."""
    _check_uint256(wei, field)
    if wei == 0:
        raise _field_error(field, "must be greater than zero (contract reverts ZeroAmount)")
    if wei < MIN_LOAN_PRINCIPAL_WEI:
        raise _field_error(
            field,
            f"is below the on-chain minimum of {wei_to_eth(MIN_LOAN_PRINCIPAL_WEI)} ETH "
            f"({MIN_LOAN_PRINCIPAL_WEI} wei); the contract would revert AmountTooSmall",
        )
    if wei > MAX_LOAN_PRINCIPAL_WEI:
        raise _field_error(
            field,
            f"exceeds the on-chain maximum of {wei_to_eth(MAX_LOAN_PRINCIPAL_WEI)} ETH "
            f"({MAX_LOAN_PRINCIPAL_WEI} wei); the contract would revert AmountTooLarge",
        )
    return wei


def validate_rate_bps(value: Any, field: str = "rateBps") -> int:
    bps = parse_int(value, field)
    if bps < 0:
        # JSON numbers reach parse_int as ints, so a negative value must be rejected here.
        raise _field_error(field, "must not be negative")
    if bps > MAX_RATE_BPS:
        raise _field_error(
            field, f"exceeds the on-chain maximum of {MAX_RATE_BPS} bps (50% APR); "
                   "the contract would revert RateTooHigh"
        )
    return bps


def validate_duration_days(value: Any, field: str = "durationDays") -> int:
    days = parse_int(value, field)
    if days < 0:
        raise _field_error(field, "must not be negative")
    if days < 1 or days > MAX_DURATION_DAYS:
        raise _field_error(
            field,
            f"must be between 1 and {MAX_DURATION_DAYS} days; the contract would revert "
            "DurationInvalid",
        )
    return days


def clamp_min_collateral_bps(min_collateral_bps: int | None) -> int:
    """Clamp a chain-reported requirement up to the immutable floor.

    ``minCollateralBps`` is owner-settable down to ``MIN_COLLATERAL_FLOOR_BPS`` (50%).  A live
    read can be missing (offline) or, if the parameter were ever mis-set, below the floor; in
    both cases the effective requirement must never fall below the floor.
    """
    if min_collateral_bps is None:
        return DEFAULT_MIN_COLLATERAL_BPS
    return max(int(min_collateral_bps), MIN_COLLATERAL_FLOOR_BPS)


def required_collateral_wei(
    principal_wei: int, min_collateral_bps: int = DEFAULT_MIN_COLLATERAL_BPS
) -> int:
    """``_mulDivUp(principal, minCollateralBps, BPS_DENOMINATOR)`` — ceiling division.

    ``min_collateral_bps`` should be the **live** value (``quotedCollateralPolicy`` in app.py);
    it defaults to the contract's initial 10_000 only when no live value is available.
    """
    product = principal_wei * min_collateral_bps
    if product == 0:
        return 0
    return (product + BPS_DENOMINATOR - 1) // BPS_DENOMINATOR


def validate_collateral_wei(
    principal_wei: int,
    collateral_wei: int,
    field: str = "collateralEth",
    *,
    min_collateral_bps: int | None = None,
) -> int:
    """Mirror ``requestLoan``'s collateral check (``InsufficientCollateral``).

    The requirement is ``ceil(principal * max(chainBps, floorBps) / 10_000)``: the live chain
    value so we never accept a loan the chain would revert on, floored at
    ``MIN_COLLATERAL_FLOOR_BPS`` so a mis-set parameter can never be exploited through the API.
    """
    effective_bps = clamp_min_collateral_bps(min_collateral_bps)
    required = required_collateral_wei(principal_wei, effective_bps)
    if collateral_wei < required:
        raise _field_error(
            field,
            f"is below the required collateral of {wei_to_eth(required)} ETH "
            f"({required} wei, {effective_bps} bps of principal) for a "
            f"{wei_to_eth(principal_wei)} ETH principal; "
            "the contract would revert InsufficientCollateral",
        )
    return collateral_wei


def collateral_requirement(
    principal_wei: int, min_collateral_bps: int | None = None
) -> dict:
    """Requirement breakdown for previews: floor bound vs the chain's current bound."""
    effective_bps = clamp_min_collateral_bps(min_collateral_bps)
    raw_bps = DEFAULT_MIN_COLLATERAL_BPS if min_collateral_bps is None else int(min_collateral_bps)
    return {
        "principalWei": principal_wei,
        "chainBps": raw_bps,
        "effectiveBps": effective_bps,
        "floorBps": MIN_COLLATERAL_FLOOR_BPS,
        "clampedToFloor": raw_bps < MIN_COLLATERAL_FLOOR_BPS,
        "requiredCollateralWei": required_collateral_wei(principal_wei, effective_bps),
        "floorCollateralWei": required_collateral_wei(principal_wei, MIN_COLLATERAL_FLOOR_BPS),
    }


def validate_deposit_wei(wei: int, field: str = "amountEth") -> int:
    """Mirror deposit(): value != 0 and value >= minDeposit."""
    if wei == 0:
        raise _field_error(field, "must be greater than zero")
    if wei < MIN_DEPOSIT_WEI:
        raise _field_error(
            field,
            f"is below the minimum deposit of {wei_to_eth(MIN_DEPOSIT_WEI)} ETH "
            f"({MIN_DEPOSIT_WEI} wei); the contract would revert AmountTooSmall",
        )
    return wei


# ---------------------------------------------------------------------------
# Interest / repayment economics (identical maths to the Solidity contract)
# ---------------------------------------------------------------------------


def preview_interest_wei(principal_wei: int, rate_bps: int, duration_days: int) -> int:
    """``(principal * rateBps * durationDays) / (BPS_DENOMINATOR * DAYS_PER_YEAR)``."""
    return (principal_wei * rate_bps * duration_days) // (BPS_DENOMINATOR * DAYS_PER_YEAR)


def base_due_wei(principal_wei: int, interest_wei: int) -> int:
    return principal_wei + interest_wei


def late_fee_wei(
    principal_wei: int,
    interest_wei: int,
    due_date: int,
    now: int,
    late_fee_bps: int = LATE_FEE_BPS,
) -> int:
    """Late fee for a started 30-day period, matching ``_previewRepayment``."""
    if now <= due_date:
        return 0
    base = principal_wei + interest_wei
    periods = (now - due_date) // LATE_PERIOD_SECONDS + 1
    return (base * late_fee_bps * periods) // BPS_DENOMINATOR


def amount_due_wei(
    principal_wei: int,
    interest_wei: int,
    due_date: int,
    now: int,
    late_fee_bps: int = LATE_FEE_BPS,
) -> tuple[int, int]:
    """Return ``(amountDue, lateFee)`` for a loan, exactly as the contract computes it."""
    fee = late_fee_wei(principal_wei, interest_wei, due_date, now, late_fee_bps)
    return principal_wei + interest_wei + fee, fee


def protocol_fee_wei(interest_wei: int, fee_bps: int = FEE_BPS) -> int:
    return (interest_wei * fee_bps) // BPS_DENOMINATOR


def repayment_breakdown(
    principal_wei: int,
    interest_wei: int,
    due_date: int,
    now: int,
    fee_bps: int = FEE_BPS,
    late_fee_bps: int = LATE_FEE_BPS,
) -> dict:
    """Full repayment settlement, mirroring ``_settleRepayment`` in the current contract.

    Fee routing (spec section 1): ``reservedLiquidity`` already carries the pool's claim on
    the principal, so settlement credits the pool with **only the income it earned** —
    ``netInterest = interest - fee`` plus any late fee.  The protocol ``fee`` accrues to the
    separate ``treasuryBalance`` claim and never enters ``totalLiquidity``.
    ``totalInterestEarned`` grows by ``interest + lateFee``.
    """
    amount_due, late_fee = amount_due_wei(
        principal_wei, interest_wei, due_date, now, late_fee_bps
    )
    fee = protocol_fee_wei(interest_wei, fee_bps)
    net_interest = interest_wei - fee
    return {
        "amountDueWei": amount_due,
        "lateFeeWei": late_fee,
        "feeWei": fee,
        "netInterestWei": net_interest,
        # Deltas to the pool's indexed claims:
        "liquidityCreditWei": net_interest + late_fee,
        "interestEarnedWei": interest_wei + late_fee,
        "treasuryCreditWei": fee,
        "reservedReleaseWei": principal_wei,
    }


def liquidation_breakdown(
    principal_wei: int,
    interest_wei: int,
    collateral_wei: int,
    due_date: int,
    now: int,
    penalty_bps: int = PENALTY_BPS,
    late_fee_bps: int = LATE_FEE_BPS,
) -> dict:
    """Liquidation settlement, mirroring ``liquidate()`` in the contract.

    Returns compensation to suppliers, refund to the borrower and bad debt.  Suppliers give
    up their claim on the written-off principal and take the seizure, so
    ``totalLiquidity = totalLiquidity - principal + compensation`` (spec section 1).  That
    delta is negative on a shortfall, which is exactly how a default shows up in
    ``totalLiquidity - reservedLiquidity``.  No protocol fee is taken on a liquidation.
    """
    owed, late_fee = amount_due_wei(principal_wei, interest_wei, due_date, now, late_fee_bps)
    if collateral_wei >= owed:
        penalty = (owed * penalty_bps) // BPS_DENOMINATOR
        compensation = min(owed + penalty, collateral_wei)
        refund = collateral_wei - compensation
        bad_debt = 0
    else:
        compensation = collateral_wei
        refund = 0
        bad_debt = owed - collateral_wei
    interest_recovered = max(owed - principal_wei, 0)
    return {
        "owedWei": owed,
        "lateFeeWei": late_fee,
        "compensationWei": compensation,
        "refundWei": refund,
        "badDebtWei": bad_debt,
        "interestRecoveredWei": interest_recovered,
        # `reservedLiquidity` is released; the supplier claim is re-struck at the seizure.
        "reservedReleaseWei": principal_wei,
        "liquidityDeltaWei": compensation - principal_wei,
    }


# ---------------------------------------------------------------------------
# Pagination / query helpers
# ---------------------------------------------------------------------------


def validate_pagination(args: Mapping[str, Any]) -> tuple[int, int]:
    """Validate ``limit``/``offset`` query parameters. Returns ``(limit, offset)``."""
    fields: dict[str, str] = {}
    limit = DEFAULT_LIMIT
    offset = 0

    raw_limit = args.get("limit")
    if raw_limit is not None and str(raw_limit) != "":
        try:
            limit = parse_int(str(raw_limit), "limit")
        except ValidationError:
            fields["limit"] = "must be a positive integer"
    if limit < 1 or limit > MAX_LIMIT:
        fields["limit"] = f"must be between 1 and {MAX_LIMIT}"

    raw_offset = args.get("offset")
    if raw_offset is not None and str(raw_offset) != "":
        try:
            offset = parse_int(str(raw_offset), "offset")
        except ValidationError:
            fields["offset"] = "must be a non-negative integer"
    if offset < 0:
        fields["offset"] = "must be a non-negative integer"

    if fields:
        raise ValidationError(fields)
    return limit, offset


def parse_loan_status(value: str) -> int:
    """Accept a status name (``active``) or numeric enum code (``2``)."""
    text = str(value).strip()
    if not text:
        raise _field_error("status", "must not be empty")
    if text.isdigit():
        code = int(text)
        if code not in LOAN_STATUS_NAMES:
            raise _field_error("status", f"unknown status code {code}")
        return code
    code = STATUS_TO_CODE.get(text.lower())
    if code is None:
        raise _field_error(
            "status",
            "must be one of " + ", ".join(sorted(LOAN_STATUS_NAMES.values())),
        )
    return code


def parse_bool_param(value: Any, field: str) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        low = value.strip().lower()
        if low in ("1", "true", "yes"):
            return True
        if low in ("0", "false", "no"):
            return False
    raise _field_error(field, "must be true or false")


ALLOWED_SIMULATE_ACTIONS = (
    "deposit",
    "withdraw",
    "requestLoan",
    "fundLoan",
    "repayLoan",
    "cancelLoan",
    "liquidate",
)


def require_fields(body: Mapping[str, Any], required: Iterable[str]) -> None:
    missing = {field: "is required" for field in required if field not in body}
    if missing:
        raise ValidationError(missing)
