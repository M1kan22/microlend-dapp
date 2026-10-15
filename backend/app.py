"""MicroLend Flask application — the REST surface in docs/INTEGRATION_SPEC.md section 3.

Every response is a JSON envelope::

    {"ok": true,  "data": {...}}
    {"ok": false, "error": {"code": "...", "message": "...", "fields": {...}}}

Nothing in this backend ever receives, stores or logs a private key: signing happens in
MetaMask and only the resulting signature crosses the wire.  ``auth.reject_private_key_material``
actively rejects key-material field names if a client tries to send them anyway.

Run it::

    python backend/app.py                 # 127.0.0.1:5000, CHAIN_MODE=mock by default

See backend/README.md for the endpoint table and environment variables.
"""

from __future__ import annotations

import functools
import json
import logging
import os
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

# Allow `python backend/app.py` and `pytest backend/tests` to import the sibling modules.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

from flask import Flask, Response, g, jsonify, request  # noqa: E402
from flask_cors import CORS  # noqa: E402
from werkzeug.exceptions import HTTPException  # noqa: E402

import auth as auth_module  # noqa: E402
import chain as chain_module  # noqa: E402
import db  # noqa: E402
import validation  # noqa: E402
from validation import (  # noqa: E402
    ALLOWED_SIMULATE_ACTIONS,
    DAYS_PER_YEAR,
    LOAN_STATUS_ACTIVE,
    LOAN_STATUS_PENDING,
    ApiError,
    ValidationError,
    amount_due_wei,
    bps_to_percent,
    eth_to_wei,
    liquidation_breakdown,
    parse_int,
    preview_interest_wei,
    required_collateral_wei,
    validate_address,
    validate_collateral_wei,
    validate_deposit_wei,
    validate_duration_days,
    validate_pagination,
    validate_principal_wei,
    validate_rate_bps,
    wei_to_eth,
)

SERVICE_NAME = "microlend-backend"
SERVICE_VERSION = "1.0.0"
API_BASE = "/api"
SECONDS_PER_DAY = 86_400

EXPLORER_DEFAULT = "https://sepolia.etherscan.io"

# Event -> transaction type, used by GET /api/transactions?type= and by the sync route.
EVENT_TO_TX_TYPE = {
    "LiquidityDeposited": "deposit",
    "LiquidityWithdrawn": "withdraw",
    "LoanRequested": "loan_request",
    "LoanFunded": "loan_fund",
    "LoanRepaid": "loan_repay",
    "LoanLiquidated": "loan_liquidate",
    "LoanCancelled": "loan_cancel",
    "TreasuryClaimed": "treasury_claim",
    "ParamsUpdated": "params_update",
    "PausedSet": "paused_set",
    "TreasurySet": "treasury_set",
    "OwnershipTransferred": "ownership_transfer",
    "Initialized": "initialize",
}

LOAN_EVENTS = {
    "LoanRequested",
    "LoanFunded",
    "LoanRepaid",
    "LoanLiquidated",
    "LoanCancelled",
}

# ---------------------------------------------------------------------------
# Structured JSON logging (never logs bodies, tokens or key material)
# ---------------------------------------------------------------------------


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.fromtimestamp(record.created, tz=timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%S.%fZ"
            ),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key in ("request_id", "method", "path", "status", "duration_ms", "remote_addr", "address", "context"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info).splitlines()[-1]
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> logging.Logger:
    logger = logging.getLogger("microlend")
    logger.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    logger.propagate = False
    return logger


# ---------------------------------------------------------------------------
# Rate limiting: a simple per-IP token bucket
# ---------------------------------------------------------------------------


class TokenBucketLimiter:
    """Per-key token bucket. ``rate_per_minute`` refills, ``burst`` is the bucket size."""

    def __init__(self, rate_per_minute: int = 120, burst: int | None = None) -> None:
        self.rate_per_second = max(rate_per_minute, 0) / 60.0
        self.burst = float(burst if burst is not None else max(rate_per_minute, 1))
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str, cost: float = 1.0) -> tuple[bool, float]:
        """Return ``(allowed, retry_after_seconds)`` and consume a token when allowed."""
        if self.rate_per_second <= 0:
            return True, 0.0
        now = time.monotonic()
        with self._lock:
            tokens, last = self._buckets.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.rate_per_second)
            if tokens >= cost:
                self._buckets[key] = (tokens - cost, now)
                return True, 0.0
            self._buckets[key] = (tokens, now)
            deficit = cost - tokens
            return False, max(deficit / self.rate_per_second, 0.001)

    def reset(self) -> None:
        with self._lock:
            self._buckets.clear()


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    try:
        return int(str(raw).strip())
    except ValueError:
        return default


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off")


def load_settings(overrides: Mapping[str, Any] | None = None) -> dict:
    """Build the app settings from the environment, then apply explicit overrides."""
    chain_id_raw = os.environ.get("CHAIN_ID")
    settings: dict[str, Any] = {
        "DATABASE_PATH": os.environ.get("DATABASE_PATH")
        or os.environ.get("MICROLEND_DB")
        or db.default_db_path(),
        "CHAIN_MODE": (os.environ.get("CHAIN_MODE") or "mock").strip().lower(),
        "CONTRACT_ADDRESS": os.environ.get("MICROLEND_CONTRACT_ADDRESS") or chain_module.MOCK_CONTRACT_ADDRESS,
        "RPC_URL": os.environ.get("RPC_URL") or "",
        "CHAIN_ID": int(chain_id_raw) if chain_id_raw and chain_id_raw.isdigit() else chain_module.DEFAULT_CHAIN_ID,
        "CHAIN_NAME": os.environ.get("CHAIN_NAME") or chain_module.DEFAULT_CHAIN_NAME,
        "EXPLORER_BASE": os.environ.get("EXPLORER_BASE") or EXPLORER_DEFAULT,
        "CORS_ORIGINS": os.environ.get("CORS_ORIGINS") or "*",
        # Absolute base for clients served from another origin (a static site in front of this
        # API). Defaults to the path-relative "/api", which is correct when the page is served
        # by this same host; set it to e.g. https://api.example.com/api behind a reverse proxy
        # so the browser is told an absolute URL instead of a relative one.
        "PUBLIC_API_BASE": (os.environ.get("PUBLIC_API_BASE") or "").rstrip("/"),
        "AUTH_TOKEN_TTL_SECONDS": _env_int("AUTH_TOKEN_TTL_SECONDS", auth_module.TOKEN_TTL_SECONDS),
        "NONCE_TTL_SECONDS": _env_int("NONCE_TTL_SECONDS", auth_module.NONCE_TTL_SECONDS),
        "RATE_LIMIT_PER_MINUTE": _env_int("RATE_LIMIT_PER_MINUTE", 240),
        "RATE_LIMIT_BURST": _env_int("RATE_LIMIT_BURST", 120),
        "RATE_LIMIT_ENABLED": _env_bool("RATE_LIMIT_ENABLED", True),
        "LOG_LEVEL": os.environ.get("LOG_LEVEL", "INFO"),
        "AUTO_SEED": _env_bool("AUTO_SEED", True),
        "AUTH_SECRET": os.environ.get("AUTH_TOKEN_SECRET")
        or os.environ.get("FLASK_SECRET_KEY")
        or "",
        "TESTING": False,
    }
    if overrides:
        settings.update({k: v for k, v in overrides.items() if v is not None})
    return settings


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app(overrides: Mapping[str, Any] | None = None) -> Flask:
    settings = load_settings(overrides)
    logger = configure_logging(settings["LOG_LEVEL"])

    app = Flask(__name__)
    app.config.update(settings)
    app.json.sort_keys = False
    # Always answer exceptions with the JSON envelope, in tests as well as in production.
    app.config["PROPAGATE_EXCEPTIONS"] = False

    secret = settings["AUTH_SECRET"]
    if not secret:
        # A random per-process secret keeps tokens valid for this run only; production and
        # tests must set FLASK_SECRET_KEY / AUTH_TOKEN_SECRET explicitly.
        secret = auth_module.secrets.token_urlsafe(32)
        settings["AUTH_SECRET"] = secret
        app.config["AUTH_SECRET"] = secret
    settings["AUTH_SECRET_FROM_ENV"] = bool(
        os.environ.get("AUTH_TOKEN_SECRET") or os.environ.get("FLASK_SECRET_KEY")
    )

    origins = settings["CORS_ORIGINS"]
    CORS(
        app,
        resources={r"/api/*": {"origins": [o.strip() for o in origins.split(",")] if origins != "*" else "*"}},
        allow_headers=["Content-Type", "Authorization", "X-Request-Id"],
        expose_headers=["X-Request-Id"],
        methods=["GET", "POST", "OPTIONS"],
    )

    limiter = TokenBucketLimiter(
        settings["RATE_LIMIT_PER_MINUTE"], settings["RATE_LIMIT_BURST"]
    )

    # A shared connection is required for :memory: databases, which do not survive reopen.
    shared_conn = None
    if settings["DATABASE_PATH"] == ":memory:":
        shared_conn = db.init_db(db.connect(":memory:"))
    else:
        db.init_db(db.connect(settings["DATABASE_PATH"]))

    state = {
        "settings": settings,
        "logger": logger,
        "limiter": limiter,
        "shared_conn": shared_conn,
        "chain": chain_module.build_chain(
            mode=settings["CHAIN_MODE"],
            contract_address=settings["CONTRACT_ADDRESS"],
            rpc_url=settings["RPC_URL"],
            chain_id=settings["CHAIN_ID"],
        ),
    }
    app.extensions["microlend"] = state

    # -- demo seed so the DApp has data on first start (offline grading) ----
    if settings["AUTO_SEED"]:
        try:
            import demo_seed

            if shared_conn is not None:
                demo_seed.ensure_seed(shared_conn, force=False)
            else:
                # Seeding happens before any request, so it must not rely on flask.g.
                seed_conn = db.init_db(db.connect(settings["DATABASE_PATH"]))
                try:
                    demo_seed.ensure_seed(seed_conn, force=False)
                finally:
                    seed_conn.close()
        except Exception as exc:  # pragma: no cover - seeding must never break startup
            logger.warning("demo seed skipped: %s", exc)

    _register_hooks(app)
    _register_error_handlers(app)
    _register_routes(app)
    return app


def get_state(app: Flask | None = None) -> dict:
    return (app or _current_app()).extensions["microlend"]


def _current_app() -> Flask:
    from flask import current_app

    return current_app


def get_conn(app: Flask | None = None):
    """Request-scoped SQLite connection (or the shared one for in-memory databases)."""
    app = app or _current_app()
    state = app.extensions["microlend"]
    if state["shared_conn"] is not None:
        return state["shared_conn"]
    if "microlend_conn" not in g:
        g.microlend_conn = db.init_db(db.connect(app.config["DATABASE_PATH"]))
    return g.microlend_conn


def get_chain(app: Flask | None = None):
    return (app or _current_app()).extensions["microlend"]["chain"]


def get_logger() -> logging.Logger:
    return _current_app().extensions["microlend"]["logger"]


# ---------------------------------------------------------------------------
# Envelope helpers
# ---------------------------------------------------------------------------


def ok(data: Any, status: int = 200) -> Response:
    response = jsonify({"ok": True, "data": data})
    response.status_code = status
    return response


def fail(code: str, message: str, status: int, fields: Mapping[str, Any] | None = None) -> Response:
    error: dict[str, Any] = {"code": code, "message": message}
    if fields:
        error["fields"] = dict(fields)
    response = jsonify({"ok": False, "error": error})
    response.status_code = status
    return response


def api_error_response(exc: ApiError) -> Response:
    response = fail(exc.code, exc.message, exc.status, exc.fields)
    if exc.code == "RATE_LIMITED":
        response.headers["Retry-After"] = "1"
    return response


def json_body(required: bool = True) -> dict:
    """Parse and sanity-check a JSON object body; rejects key material outright."""
    raw = request.get_data(cache=True)
    data = request.get_json(silent=True)
    if data is None:
        if raw and raw.strip():
            raise ValidationError({"_request": "request body must be valid JSON"})
        if required:
            raise ValidationError({"_request": "a JSON object body is required"})
        data = {}
    if not isinstance(data, dict):
        raise ValidationError({"_request": "request body must be a JSON object"})
    auth_module.reject_private_key_material(data)
    return data


def query_arg(name: str) -> str | None:
    value = request.args.get(name)
    if value is None:
        return None
    value = value.strip()
    return value or None


def bearer_token(required: bool = True) -> str | None:
    header = request.headers.get("Authorization") or ""
    parts = header.split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        if required:
            raise ApiError(
                "AUTH_REQUIRED",
                "This endpoint requires an Authorization: Bearer <token> header. Sign in "
                "with /api/auth/nonce + /api/auth/verify first.",
            )
        return None
    return parts[1].strip()


def require_auth(view: Callable) -> Callable:
    """Require a valid session token; exposes ``g.address`` / ``g.session``."""

    @functools.wraps(view)
    def wrapper(*args: Any, **kwargs: Any):
        token = bearer_token()
        conn = get_conn()
        session = auth_module.resolve_session(
            conn, token, secret=_current_app().config["AUTH_SECRET"]
        )
        g.address = session["address"]
        g.session = session
        return view(*args, **kwargs)

    return wrapper


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def _register_hooks(app: Flask) -> None:
    @app.before_request
    def _before():  # pragma: no cover - exercised through every request
        g.request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:16]
        g.started_at = time.monotonic()
        g.address = None

        state = app.extensions["microlend"]
        settings = state["settings"]
        if settings["RATE_LIMIT_ENABLED"] and request.path.startswith(API_BASE):
            remote = request.remote_addr or "unknown"
            allowed, retry_after = state["limiter"].check(remote)
            if not allowed:
                response = fail(
                    "RATE_LIMITED",
                    "Too many requests: the per-IP token bucket is empty. Slow down and retry.",
                    429,
                )
                response.headers["Retry-After"] = str(max(int(retry_after) + 1, 1))
                return response
        return None

    @app.after_request
    def _after(response: Response):
        response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        response.headers["X-Content-Type-Options"] = "nosniff"
        # /api must never answer with an HTML error page (spec section 3). CORS preflight
        # (OPTIONS) legitimately has an empty body, so it is left alone.
        if (
            request.path.startswith(API_BASE)
            and request.method != "OPTIONS"
            and response.status_code >= 400
            and response.mimetype == "text/html"
        ):
            response = fail(
                "INTERNAL_ERROR",
                "The API only produces JSON responses.",
                response.status_code if response.status_code >= 400 else 500,
            )
            response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        return response

    @app.teardown_request
    def _teardown(exc):  # pragma: no cover
        conn = g.pop("microlend_conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _log_request(status: int) -> None:
    state = _current_app().extensions["microlend"]
    duration_ms = round((time.monotonic() - getattr(g, "started_at", time.monotonic())) * 1000, 2)
    state["logger"].info(
        "request",
        extra={
            "request_id": getattr(g, "request_id", None),
            "method": request.method,
            "path": request.path,
            "status": status,
            "duration_ms": duration_ms,
            "remote_addr": request.remote_addr,
            "address": getattr(g, "address", None),
        },
    )


# ---------------------------------------------------------------------------
# Error handlers — every failure is JSON, never HTML
# ---------------------------------------------------------------------------


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _api_error(exc: ApiError):
        response = api_error_response(exc)
        response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        return response

    @app.errorhandler(HTTPException)
    def _http_error(exc: HTTPException):
        code = {
            400: ("VALIDATION_ERROR", "The request could not be understood."),
            401: ("AUTH_REQUIRED", "Authentication is required."),
            404: ("NOT_FOUND", "No such endpoint or resource."),
            405: ("NOT_FOUND", "That HTTP method is not allowed on this endpoint."),
            409: ("CONFLICT", "The request conflicts with the current state."),
            413: ("VALIDATION_ERROR", "The request body is too large."),
            415: ("VALIDATION_ERROR", "Unsupported media type; send application/json."),
            429: ("RATE_LIMITED", "Too many requests."),
        }.get(exc.code or 500, ("INTERNAL_ERROR", "Unexpected server error."))
        status = exc.code if isinstance(exc.code, int) and exc.code < 500 else 500
        message = exc.description or code[1]
        if exc.code == 405:
            message = f"Method {request.method} is not allowed on {request.path}."
        elif exc.code == 404:
            message = f"No API route matches {request.method} {request.path}."
        response = fail(code[0], message, status)
        response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        _log_request(status)
        return response

    @app.errorhandler(Exception)
    def _unhandled(exc: Exception):  # pragma: no cover - defensive
        state = app.extensions["microlend"]
        state["logger"].error(
            "unhandled exception",
            exc_info=exc,
            extra={"request_id": getattr(g, "request_id", None), "path": request.path},
        )
        response = fail(
            "INTERNAL_ERROR",
            "An unexpected server error occurred. The request id above identifies the log entry.",
            500,
        )
        response.headers["X-Request-Id"] = getattr(g, "request_id", "")
        return response


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def collateral_policy(app: Flask, conn) -> dict:
    """The *live* collateral requirement, plus where it came from.

    ``minCollateralBps`` is owner-settable in ``MicroLendPool`` (immutable floor 5000), so it
    must never be hard-coded:

    * ``CHAIN_MODE=rpc`` reads the public ``minCollateralBps()`` getter over ``eth_call``;
    * ``CHAIN_MODE=mock`` has no chain, so it uses the indexed value in ``pool_state``
      (default 10_000, the contract's initial setting);
    * either value is clamped **up** to ``MIN_COLLATERAL_FLOOR_BPS``, so a missing read or a
      mis-set parameter can never let the API accept collateral the chain would reject.
    """
    chain = app.extensions["microlend"]["chain"]
    raw = None
    source = "indexer"
    try:
        raw = chain.min_collateral_bps()
    except ApiError:
        raw = None
    if raw is not None:
        source = "chain"
    else:
        raw = db.pool_min_collateral_bps(conn)
        if chain.mode == "rpc":
            source = "indexer-fallback"
    effective = validation.clamp_min_collateral_bps(raw)
    return {
        "chainBps": int(raw),
        "effectiveBps": effective,
        "floorBps": validation.MIN_COLLATERAL_FLOOR_BPS,
        "defaultBps": validation.DEFAULT_MIN_COLLATERAL_BPS,
        "source": source,
        "clampedToFloor": int(raw) < validation.MIN_COLLATERAL_FLOOR_BPS,
    }


def contract_params(app: Flask | None = None, conn=None) -> dict:
    """The on-chain parameter set (spec section 2.1).

    ``minCollateralBps`` is reported from the chain when available; the other limits are the
    contract's current settings mirrored in ``validation.py`` (the API has no governance
    endpoints, so they are not re-read here).
    """
    params = {
        "minDepositWei": str(validation.MIN_DEPOSIT_WEI),
        "minDepositEth": wei_to_eth(validation.MIN_DEPOSIT_WEI),
        "minLoanPrincipalWei": str(validation.MIN_LOAN_PRINCIPAL_WEI),
        "minLoanPrincipalEth": wei_to_eth(validation.MIN_LOAN_PRINCIPAL_WEI),
        "maxLoanPrincipalWei": str(validation.MAX_LOAN_PRINCIPAL_WEI),
        "maxLoanPrincipalEth": wei_to_eth(validation.MAX_LOAN_PRINCIPAL_WEI),
        "maxDurationDays": validation.MAX_DURATION_DAYS,
        "maxRateBps": validation.MAX_RATE_BPS,
        "defaultMinCollateralBps": validation.DEFAULT_MIN_COLLATERAL_BPS,
        "minCollateralFloorBps": validation.MIN_COLLATERAL_FLOOR_BPS,
        "feeBps": validation.FEE_BPS,
        "penaltyBps": validation.PENALTY_BPS,
        "lateFeeBps": validation.LATE_FEE_BPS,
        "bpsDenominator": validation.BPS_DENOMINATOR,
        "daysPerYear": validation.DAYS_PER_YEAR,
    }
    if app is not None and conn is not None:
        policy = collateral_policy(app, conn)
        params["minCollateralBps"] = policy["effectiveBps"]
        params["minCollateralBpsRaw"] = policy["chainBps"]
        params["minCollateralBpsSource"] = policy["source"]
        params["minCollateralBpsClampedToFloor"] = policy["clampedToFloor"]
    else:  # pragma: no cover - only reached before a connection exists
        params["minCollateralBps"] = validation.DEFAULT_MIN_COLLATERAL_BPS
        params["minCollateralBpsRaw"] = validation.DEFAULT_MIN_COLLATERAL_BPS
        params["minCollateralBpsSource"] = "default"
        params["minCollateralBpsClampedToFloor"] = False
    return params


def pool_snapshot(conn, app: Flask) -> dict:
    """Indexed pool snapshot enriched with contract metadata and (in rpc mode) live stats."""
    state = app.extensions["microlend"]
    settings = state["settings"]
    data = db.pool_snapshot(conn)
    data.update(
        {
            "contractAddress": state["chain"].contract_address,
            "chainId": settings["CHAIN_ID"],
            "chainName": settings["CHAIN_NAME"],
            "explorerBase": settings["EXPLORER_BASE"],
            "chainMode": state["chain"].mode,
            "source": "indexer",
            "params": contract_params(app, conn),
            "collateralPolicy": collateral_policy(app, conn),
            "treasuryAddress": os.environ.get("MICROLEND_TREASURY_ADDRESS") or None,
            "ownerAddress": None,
            "paused": data.get("paused", False),
        }
    )

    live = state["chain"].pool_stats()
    if live:
        names = (
            "totalShares",
            "totalLiquidity",
            "availableLiquidity",
            "reservedLiquidity",
            "totalDeposited",
            "totalInterestEarned",
            "totalFeesCollected",
            "totalBadDebt",
            "treasuryBalance",
            "loanCount",
            "sharePrice",
            "paused",
        )
        outputs = state["chain"].functions["poolStats"].get("outputs", [])
        on_chain: dict[str, Any] = {}
        for index, item in enumerate(outputs):
            key = item.get("name") or names[index]
            value = live.get(key, live.get(names[index]))
            if item["type"] == "bool":
                on_chain[key] = bool(value)
            else:
                on_chain[f"{key}Wei"] = str(value)
                on_chain[f"{key}Eth"] = wei_to_eth(int(value))
        data["onChain"] = on_chain
        data["source"] = "indexer+chain"
        data["paused"] = on_chain.get("paused", data.get("paused", False))
    return data


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


def _register_routes(app: Flask) -> None:
    # ---- health / config -------------------------------------------------

    @app.get(f"{API_BASE}/health")
    def health():
        state = app.extensions["microlend"]
        conn = get_conn()
        return ok(
            {
                "status": "ok",
                "service": SERVICE_NAME,
                "version": SERVICE_VERSION,
                "time": int(time.time()),
                "isoTime": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "chainMode": state["chain"].mode,
                "chainId": app.config["CHAIN_ID"],
                "contractAddress": state["chain"].contract_address,
                "database": {
                    "path": app.config["DATABASE_PATH"],
                    "tables": db.table_counts(conn),
                },
                "chain": state["chain"].health(),
                "rateLimitEnabled": state["settings"]["RATE_LIMIT_ENABLED"],
            }
        )

    @app.get(f"{API_BASE}/config")
    def config():
        state = app.extensions["microlend"]
        abi = chain_module.load_abi()
        return ok(
            {
                "chainId": app.config["CHAIN_ID"],
                "chainName": app.config["CHAIN_NAME"],
                "contractAddress": state["chain"].contract_address,
                "explorerBase": app.config["EXPLORER_BASE"] or "",
                "apiBase": app.config["PUBLIC_API_BASE"] or API_BASE,
                "rpcUrl": app.config["RPC_URL"] or "",
                "chainMode": state["chain"].mode,
                "demoMode": state["chain"].mode == "mock",
                "tokenSymbol": "ETH",
                "tokenDecimals": 18,
                "pollMs": 15000,
                "buildLabel": f"backend {SERVICE_VERSION}",
                "abi": abi,
                "contractAbi": abi,
                "params": contract_params(app, get_conn()),
                "endpoints": sorted(_route_table()),
            }
        )

    # ---- auth ------------------------------------------------------------

    @app.post(f"{API_BASE}/auth/nonce")
    def auth_nonce():
        body = json_body()
        address = validate_address(body.get("address"), "address")
        nonce = auth_module.issue_nonce(
            get_conn(),
            address,
            chain_id=app.config["CHAIN_ID"],
            ttl=app.config["NONCE_TTL_SECONDS"],
        )
        return ok(nonce, 201)

    @app.post(f"{API_BASE}/auth/verify")
    def auth_verify():
        body = json_body()
        validation.require_fields(body, ("address", "signature"))
        address = validate_address(body.get("address"), "address")
        signature = body.get("signature")
        if not isinstance(signature, str):
            raise ValidationError({"signature": "must be a hex string"})
        session = auth_module.consume_nonce_and_issue_token(
            get_conn(),
            address,
            signature,
            secret=app.config["AUTH_SECRET"],
            chain_id=app.config["CHAIN_ID"],
            token_ttl=app.config["AUTH_TOKEN_TTL_SECONDS"],
        )
        return ok(session)

    @app.get(f"{API_BASE}/auth/session")
    @require_auth
    def auth_session():
        return ok({"address": g.address, "expiresAt": g.session["expiresAt"]})

    @app.post(f"{API_BASE}/auth/logout")
    @require_auth
    def auth_logout():
        auth_module.revoke_session(get_conn(), bearer_token())
        return ok({"loggedOut": True})

    # ---- pool ------------------------------------------------------------

    @app.get(f"{API_BASE}/pool")
    def pool():
        return ok(pool_snapshot(get_conn(), app))

    # ---- loans (read) ----------------------------------------------------

    @app.get(f"{API_BASE}/loans")
    def list_loans():
        limit, offset = validate_pagination(request.args)
        status_code = None
        raw_status = query_arg("status")
        if raw_status is not None:
            status_code = validation.parse_loan_status(raw_status)
        borrower = None
        raw_borrower = query_arg("borrower")
        if raw_borrower is not None:
            borrower = validate_address(raw_borrower, "borrower")
        items, total = db.list_loans(
            get_conn(), status=status_code, borrower=borrower, limit=limit, offset=offset
        )
        return ok({"items": items, "total": total, "limit": limit, "offset": offset})

    @app.get(f"{API_BASE}/loans/<int:loan_id>")
    def get_loan(loan_id: int):
        return ok(db.get_loan(get_conn(), loan_id))

    @app.get(f"{API_BASE}/loans/<int:loan_id>/history")
    def loan_history(loan_id: int):
        conn = get_conn()
        db.get_loan(conn, loan_id)  # 404 when unknown
        return ok({"items": db.list_events(conn, loan_id)})

    @app.post(f"{API_BASE}/loans/preview")
    def preview_loan():
        body = json_body()
        validation.require_fields(body, ("principalEth", "rateBps", "durationDays"))
        principal_wei = validate_principal_wei(eth_to_wei(body["principalEth"], "principalEth"))
        rate_bps = validate_rate_bps(body["rateBps"])
        duration_days = validate_duration_days(body["durationDays"])

        conn = get_conn()
        policy = collateral_policy(app, conn)
        estimate = _loan_estimate(
            principal_wei, rate_bps, duration_days, policy["effectiveBps"]
        )
        warnings: list[str] = []

        # Optional collateralEth lets the UI compare its planned collateral against the chain's
        # *current* requirement. Between the immutable floor and the live minimum we warn rather
        # than error; below the floor we fail, because nothing can accept that amount.
        raw_collateral = body.get("collateralEth")
        if raw_collateral is not None:
            collateral_wei = eth_to_wei(raw_collateral, "collateralEth")
            requirement = validation.collateral_requirement(principal_wei, policy["chainBps"])
            estimate["collateralWei"] = str(collateral_wei)
            estimate["collateralEth"] = wei_to_eth(collateral_wei)
            estimate["floorCollateralWei"] = str(requirement["floorCollateralWei"])
            estimate["floorCollateralEth"] = wei_to_eth(requirement["floorCollateralWei"])
            if collateral_wei < requirement["floorCollateralWei"]:
                # Below the immutable floor: reject with a field-level validation error.
                validate_collateral_wei(
                    principal_wei,
                    collateral_wei,
                    "collateralEth",
                    min_collateral_bps=policy["effectiveBps"],
                )
            elif collateral_wei < requirement["requiredCollateralWei"]:
                estimate["collateralSufficient"] = False
                warnings.append(
                    f"Collateral of {wei_to_eth(collateral_wei)} ETH covers the immutable "
                    f"{policy['floorBps']} bps floor ({wei_to_eth(requirement['floorCollateralWei'])} ETH) "
                    f"but is below the pool's current minCollateralBps of {policy['chainBps']} bps "
                    f"({wei_to_eth(requirement['requiredCollateralWei'])} ETH, source "
                    f"{policy['source']}); requestLoan would revert InsufficientCollateral."
                )
            else:
                estimate["collateralSufficient"] = True

        estimate["collateralPolicy"] = policy
        estimate["warnings"] = warnings
        return ok(estimate)

    # ---- loans (write) ---------------------------------------------------

    @app.post(f"{API_BASE}/loans")
    @require_auth
    def create_loan():
        conn = get_conn()
        state = app.extensions["microlend"]
        body = json_body()
        validation.require_fields(
            body, ("principalEth", "rateBps", "durationDays", "collateralEth", "txHash")
        )
        principal_wei = validate_principal_wei(eth_to_wei(body["principalEth"], "principalEth"))
        rate_bps = validate_rate_bps(body["rateBps"])
        duration_days = validate_duration_days(body["durationDays"])
        collateral_wei = eth_to_wei(body["collateralEth"], "collateralEth")
        policy = collateral_policy(app, conn)
        validate_collateral_wei(
            principal_wei,
            collateral_wei,
            "collateralEth",
            min_collateral_bps=policy["effectiveBps"],
        )
        tx_hash = _require_tx_hash(body.get("txHash"))

        interest_wei = preview_interest_wei(principal_wei, rate_bps, duration_days)
        snapshot = db.pool_snapshot(conn)
        available = int(snapshot["availableLiquidityWei"])
        will_activate = available >= principal_wei and not snapshot["paused"]

        now = db.now_ts()
        hints = {
            "loanId": db.next_loan_id(conn),
            "borrower": g.address,
        }
        if will_activate:
            hints["startTime"] = now
            hints["dueDate"] = now + duration_days * SECONDS_PER_DAY

        event = state["chain"].verify_event(
            tx_hash,
            "LoanRequested",
            actor=g.address,
            expectations={
                "borrower": g.address,
                "principal": principal_wei,
                "interest": interest_wei,
                "rateBps": rate_bps,
                "durationDays": duration_days,
                "collateral": collateral_wei,
            },
            hints=hints,
        )
        _reject_duplicate_tx(conn, tx_hash)

        loan_id = int(event.values.get("loanId") or hints["loanId"])
        if db.get_loan_row(conn, loan_id) is not None:
            raise ApiError("CONFLICT", f"Loan {loan_id} has already been indexed.")

        status_code = LOAN_STATUS_ACTIVE if will_activate else LOAN_STATUS_PENDING
        loan = db.insert_loan(
            conn,
            {
                "loan_id": loan_id,
                "borrower": g.address,
                "principal_wei": principal_wei,
                "collateral_wei": collateral_wei,
                "interest_wei": interest_wei,
                "rate_bps": rate_bps,
                "duration_days": duration_days,
                "start_time": now if will_activate else 0,
                "due_date": now + duration_days * SECONDS_PER_DAY if will_activate else 0,
                "status_code": status_code,
                "funded_wei": principal_wei if will_activate else 0,
                "tx_hash_created": tx_hash,
                "created_at": now,
            },
        )
        db.apply_request_to_pool(
            conn,
            collateral_wei=collateral_wei,
            activated=will_activate,
            principal_wei=principal_wei,
        )
        db.insert_event(
            conn,
            loan_id=loan_id,
            event_type="LoanRequested",
            actor=g.address,
            amount_wei=collateral_wei,
            block_number=event.block_number,
            tx_hash=tx_hash,
            log_index=event.log_index,
            payload={
                "principalWei": str(principal_wei),
                "interestWei": str(interest_wei),
                "rateBps": rate_bps,
                "durationDays": duration_days,
                "collateralWei": str(collateral_wei),
                "activated": will_activate,
                "chainMode": event.mode,
            },
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=g.address,
            type_="loan_request",
            amount_wei=collateral_wei,
            gas_used=event.gas_used,
            block_number=event.block_number,
            description=(
                f"Requested a {wei_to_eth(principal_wei)} ETH loan at "
                f"{bps_to_percent(rate_bps)}% APR for {duration_days} days"
                f"{' (activated immediately)' if will_activate else ' (awaiting funding)'}"
            ),
            loan_id=loan_id,
        )
        get_logger().info(
            "loan created",
            extra={"request_id": g.request_id, "address": g.address, "context": {"loanId": loan_id, "txHash": tx_hash}},
        )
        return ok(loan, 201)

    @app.post(f"{API_BASE}/loans/<int:loan_id>/fund")
    @require_auth
    def fund_loan(loan_id: int):
        conn = get_conn()
        state = app.extensions["microlend"]
        body = json_body()
        validation.require_fields(body, ("amountEth", "txHash"))
        _require_loan_status(conn, loan_id, (LOAN_STATUS_PENDING,), "fund")
        current = db.get_loan(conn, loan_id)
        principal = int(current["principalWei"])
        funded = int(current["fundedWei"])
        remaining = principal - funded

        amount_wei = eth_to_wei(body["amountEth"], "amountEth")
        if amount_wei == 0:
            raise ValidationError({"amountEth": "must be greater than zero"})
        if amount_wei > remaining:
            raise ValidationError(
                {
                    "amountEth": (
                        f"exceeds the remaining {wei_to_eth(remaining)} ETH needed to fund "
                        f"loan {loan_id} (contract would revert AmountTooLarge)"
                    )
                }
            )
        tx_hash = _require_tx_hash(body.get("txHash"))
        total_funded = funded + amount_wei
        will_activate = total_funded == principal

        now = db.now_ts()
        event = state["chain"].verify_event(
            tx_hash,
            "LoanFunded",
            actor=g.address,
            expectations={
                "loanId": loan_id,
                "funder": g.address,
                "amount": amount_wei,
                "totalFunded": total_funded,
            },
        )
        _reject_duplicate_tx(conn, tx_hash)

        snapshot = db.pool_snapshot(conn)
        total_liquidity = int(snapshot["totalLiquidityWei"])
        total_shares = int(snapshot["totalSharesWei"])
        shares = amount_wei if total_shares == 0 else (amount_wei * total_shares) // max(total_liquidity, 1)

        changes: dict[str, Any] = {"funded_wei": total_funded}
        if will_activate:
            changes["status_code"] = LOAN_STATUS_ACTIVE
            changes["start_time"] = now
            changes["due_date"] = now + int(current["durationDays"]) * SECONDS_PER_DAY
        loan = db.update_loan(conn, loan_id, **changes)
        db.apply_funding_to_pool(
            conn,
            amount_wei=amount_wei,
            shares_wei=shares,
            activated=will_activate,
            principal_wei=principal,
        )
        db.insert_event(
            conn,
            loan_id=loan_id,
            event_type="LoanFunded",
            actor=g.address,
            amount_wei=amount_wei,
            block_number=event.block_number,
            tx_hash=tx_hash,
            log_index=event.log_index,
            payload={
                "totalFundedWei": str(total_funded),
                "activated": will_activate,
                "chainMode": event.mode,
            },
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=g.address,
            type_="loan_fund",
            amount_wei=amount_wei,
            gas_used=event.gas_used,
            block_number=event.block_number,
            description=f"Funded {wei_to_eth(amount_wei)} ETH of loan {loan_id}",
            loan_id=loan_id,
        )
        return ok(loan)

    @app.post(f"{API_BASE}/loans/<int:loan_id>/repay")
    @require_auth
    def repay_loan(loan_id: int):
        conn = get_conn()
        state = app.extensions["microlend"]
        body = json_body()
        validation.require_fields(body, ("amountEth", "txHash"))
        _require_loan_status(conn, loan_id, (LOAN_STATUS_ACTIVE,), "repay")
        current = db.get_loan(conn, loan_id)
        principal = int(current["principalWei"])
        interest = int(current["interestWei"])
        due_date = int(current["dueDate"])
        now = db.now_ts()
        amount_due, late_fee = amount_due_wei(principal, interest, due_date, now)

        amount_wei = eth_to_wei(body["amountEth"], "amountEth")
        if amount_wei < amount_due:
            raise ValidationError(
                {
                    "amountEth": (
                        f"is below the {wei_to_eth(amount_due)} ETH required to settle loan "
                        f"{loan_id}"
                        + (f" (includes {wei_to_eth(late_fee)} ETH late fee)" if late_fee else "")
                        + "; the contract would revert InsufficientPayment"
                    )
                }
            )
        tx_hash = _require_tx_hash(body.get("txHash"))
        breakdown = validation.repayment_breakdown(principal, interest, due_date, now)

        event = state["chain"].verify_event(
            tx_hash,
            "LoanRepaid",
            actor=g.address,
            expectations={
                "loanId": loan_id,
                "payer": g.address,
                "principal": principal,
                "interest": interest,
                "lateFee": late_fee,
                "fee": breakdown["feeWei"],
                "totalPaid": amount_wei,
            },
        )
        _reject_duplicate_tx(conn, tx_hash)

        loan = db.update_loan(
            conn, loan_id, status_code=validation.LOAN_STATUS_REPAID, tx_hash_repaid=tx_hash
        )
        db.apply_repayment_to_pool(
            conn,
            principal_wei=principal,
            interest_wei=interest,
            late_fee_wei=late_fee,
            fee_wei=breakdown["feeWei"],
            collateral_wei=int(current["collateralWei"]),
        )
        db.insert_event(
            conn,
            loan_id=loan_id,
            event_type="LoanRepaid",
            actor=g.address,
            amount_wei=amount_wei,
            block_number=event.block_number,
            tx_hash=tx_hash,
            log_index=event.log_index,
            payload={
                "principalWei": str(principal),
                "interestWei": str(interest),
                "lateFeeWei": str(late_fee),
                "feeWei": str(breakdown["feeWei"]),
                "netInterestWei": str(breakdown["netInterestWei"]),
                "totalPaidWei": str(amount_wei),
                "chainMode": event.mode,
            },
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=g.address,
            type_="loan_repay",
            amount_wei=amount_wei,
            gas_used=event.gas_used,
            block_number=event.block_number,
            description=f"Repaid {wei_to_eth(amount_wei)} ETH on loan {loan_id}",
            loan_id=loan_id,
        )
        return ok(loan)

    @app.post(f"{API_BASE}/loans/<int:loan_id>/liquidate")
    @require_auth
    def liquidate_loan(loan_id: int):
        conn = get_conn()
        state = app.extensions["microlend"]
        body = json_body()
        validation.require_fields(body, ("txHash",))
        _require_loan_status(conn, loan_id, (LOAN_STATUS_ACTIVE,), "liquidate")
        current = db.get_loan(conn, loan_id)
        now = db.now_ts()
        if now <= int(current["dueDate"]):
            raise ApiError(
                "CONFLICT",
                f"Loan {loan_id} is not overdue yet (due at {current['dueDate']}); "
                "the contract would revert LoanNotOverdue.",
            )
        principal = int(current["principalWei"])
        interest = int(current["interestWei"])
        collateral = int(current["collateralWei"])
        breakdown = liquidation_breakdown(
            principal, interest, collateral, int(current["dueDate"]), now
        )
        tx_hash = _require_tx_hash(body.get("txHash"))

        event = state["chain"].verify_event(
            tx_hash,
            "LoanLiquidated",
            actor=g.address,
            expectations={
                "loanId": loan_id,
                "borrower": current["borrower"],
                "liquidator": g.address,
                "collateralSeized": collateral,
                "compensation": breakdown["compensationWei"],
                "refund": breakdown["refundWei"],
                "badDebt": breakdown["badDebtWei"],
            },
        )
        _reject_duplicate_tx(conn, tx_hash)

        loan = db.update_loan(
            conn, loan_id, status_code=validation.LOAN_STATUS_LIQUIDATED
        )
        db.apply_liquidation_to_pool(
            conn,
            principal_wei=principal,
            compensation_wei=breakdown["compensationWei"],
            collateral_wei=collateral,
            bad_debt_wei=breakdown["badDebtWei"],
            interest_wei=breakdown["interestRecoveredWei"],
        )
        db.insert_event(
            conn,
            loan_id=loan_id,
            event_type="LoanLiquidated",
            actor=g.address,
            amount_wei=breakdown["compensationWei"],
            block_number=event.block_number,
            tx_hash=tx_hash,
            log_index=event.log_index,
            payload={
                "collateralSeizedWei": str(collateral),
                "compensationWei": str(breakdown["compensationWei"]),
                "refundWei": str(breakdown["refundWei"]),
                "badDebtWei": str(breakdown["badDebtWei"]),
                "owedWei": str(breakdown["owedWei"]),
                "chainMode": event.mode,
            },
        )
        db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=g.address,
            type_="loan_liquidate",
            amount_wei=breakdown["compensationWei"],
            gas_used=event.gas_used,
            block_number=event.block_number,
            description=f"Liquidated overdue loan {loan_id}",
            loan_id=loan_id,
        )
        return ok(loan)

    # ---- transactions ----------------------------------------------------

    @app.get(f"{API_BASE}/transactions")
    def list_transactions():
        limit, offset = validate_pagination(request.args)
        address = query_arg("address")
        if address is not None:
            address = validate_address(address, "address")
        items, total = db.list_transactions(
            get_conn(),
            address=address,
            type_=query_arg("type"),
            status=query_arg("status"),
            limit=limit,
            offset=offset,
        )
        return ok({"items": items, "total": total, "limit": limit, "offset": offset})

    @app.post(f"{API_BASE}/transactions/sync")
    @require_auth
    def sync_transaction():
        conn = get_conn()
        state = app.extensions["microlend"]
        body = json_body()
        validation.require_fields(body, ("txHash",))
        tx_hash = _require_tx_hash(body.get("txHash"))

        event_name = body.get("event") or "LiquidityDeposited"
        if event_name not in state["chain"].events:
            raise ValidationError(
                {"event": f"unknown event name; expected one of {', '.join(sorted(state['chain'].events))}"}
            )

        expectations: dict[str, Any] = {}
        hints: dict[str, Any] = {}
        amount_wei = 0
        if event_name == "LiquidityDeposited":
            amount_wei = eth_to_wei(body.get("amountEth", "0"), "amountEth")
            validate_deposit_wei(amount_wei)
            expectations = {
                "supplier": g.address,
                "amount": amount_wei,
                "sharesMinted": amount_wei,
            }
        elif event_name == "LiquidityWithdrawn":
            amount_wei = eth_to_wei(body.get("amountEth", "0"), "amountEth")
            expectations = {
                "supplier": g.address,
                "sharesBurned": amount_wei,
                "amountReturned": amount_wei,
            }
        elif event_name in LOAN_EVENTS:
            loan_id = parse_int(body.get("loanId"), "loanId")
            loan = db.get_loan_row(conn, loan_id)
            if loan is None:
                raise ApiError("NOT_FOUND", f"Loan {loan_id} was not found in the index.")
            amount_wei = eth_to_wei(body.get("amountEth", "0"), "amountEth")
            hints = {"loanId": loan_id}
            if event_name == "LoanRepaid":
                expectations = {
                    "loanId": loan_id,
                    "payer": g.address,
                    "principal": int(loan["principal_wei"]),
                    "interest": int(loan["interest_wei"]),
                }
            elif event_name == "LoanLiquidated":
                expectations = {
                    "loanId": loan_id,
                    "borrower": loan["borrower"],
                    "liquidator": g.address,
                }
            elif event_name == "LoanRequested":
                expectations = {"loanId": loan_id, "borrower": loan["borrower"]}
            else:
                expectations = {"loanId": loan_id}

        event = state["chain"].verify_event(
            tx_hash, event_name, actor=g.address, expectations=expectations, hints=hints
        )
        _reject_duplicate_tx(conn, tx_hash)

        if event_name == "LiquidityDeposited" and amount_wei:
            db.apply_deposit_to_pool(conn, amount_wei=amount_wei, shares_wei=amount_wei)
        elif event_name == "LiquidityWithdrawn" and amount_wei:
            db.apply_withdraw_from_pool(conn, amount_wei=amount_wei, shares_wei=amount_wei)

        transaction = db.insert_transaction(
            conn,
            tx_hash=tx_hash,
            address=g.address,
            type_=EVENT_TO_TX_TYPE.get(event_name, event_name.lower()),
            amount_wei=amount_wei,
            gas_used=event.gas_used,
            block_number=event.block_number,
            description=body.get("description") or f"Synced {event_name} from the chain",
        )
        if event_name in LOAN_EVENTS and "loanId" in event.values:
            try:
                db.insert_event(
                    conn,
                    loan_id=int(event.values["loanId"]),
                    event_type=event_name,
                    actor=g.address,
                    amount_wei=amount_wei,
                    block_number=event.block_number,
                    tx_hash=tx_hash,
                    log_index=event.log_index,
                    payload={"synced": True, "chainMode": event.mode},
                )
            except ApiError:
                # The event row already existed; the transaction row is still refreshed.
                pass
        return ok(transaction)

    # ---- positions -------------------------------------------------------

    @app.get(f"{API_BASE}/positions/<address>")
    def position(address: str):
        checksum = validate_address(address, "address")
        conn = get_conn()
        data = db.user_position(conn, checksum)
        snapshot = db.pool_snapshot(conn)
        data.update(
            {
                "contractAddress": app.extensions["microlend"]["chain"].contract_address,
                "chainId": app.config["CHAIN_ID"],
                "poolSharePriceWei": snapshot["sharePriceWei"],
                "availableLiquidityWei": snapshot["availableLiquidityWei"],
                "poolTotalLiquidityWei": snapshot["totalLiquidityWei"],
            }
        )
        return ok(data)

    # ---- simulate --------------------------------------------------------

    @app.post(f"{API_BASE}/simulate")
    def simulate():
        body = json_body()
        validation.require_fields(body, ("action",))
        action = body.get("action")
        if not isinstance(action, str) or action not in ALLOWED_SIMULATE_ACTIONS:
            raise ValidationError(
                {
                    "action": "must be one of " + ", ".join(ALLOWED_SIMULATE_ACTIONS),
                }
            )
        params = body.get("params") or {}
        if not isinstance(params, dict):
            raise ValidationError({"params": "must be a JSON object"})
        auth_module.reject_private_key_material(params)
        return ok(_simulate(get_conn(), app, action, params))


# ---------------------------------------------------------------------------
# Route internals
# ---------------------------------------------------------------------------


def _route_table() -> set[str]:
    """The documented endpoint list (kept in sync with docs/INTEGRATION_SPEC.md section 3)."""
    return {
        "GET /api/health",
        "GET /api/config",
        "POST /api/auth/nonce",
        "POST /api/auth/verify",
        "GET /api/auth/session",
        "POST /api/auth/logout",
        "GET /api/pool",
        "GET /api/loans",
        "GET /api/loans/<loan_id>",
        "GET /api/loans/<loan_id>/history",
        "POST /api/loans/preview",
        "POST /api/loans",
        "POST /api/loans/<loan_id>/fund",
        "POST /api/loans/<loan_id>/repay",
        "POST /api/loans/<loan_id>/liquidate",
        "GET /api/transactions",
        "POST /api/transactions/sync",
        "GET /api/positions/<address>",
        "POST /api/simulate",
    }


def _require_tx_hash(value: Any) -> str:
    if not chain_module.is_tx_hash(value):
        raise ValidationError(
            {"txHash": "must be a 32-byte transaction hash (0x + 64 hex characters)"}
        )
    return value


def _reject_duplicate_tx(conn, tx_hash: str) -> None:
    existing = db.get_transaction(conn, tx_hash)
    if existing is not None:
        raise ApiError(
            "CONFLICT",
            f"Transaction {tx_hash} has already been indexed as a "
            f"{existing['type']} ({existing['createdAt']}); refusing to index it twice.",
        )


def _require_loan_status(conn, loan_id: int, allowed: tuple[int, ...], action: str):
    loan = db.get_loan(conn, loan_id)  # raises 404 when unknown
    if int(loan["statusCode"]) not in allowed:
        expected = " or ".join(validation.LOAN_STATUS_NAMES[code] for code in allowed)
        raise ApiError(
            "CONFLICT",
            f"Loan {loan_id} is {loan['status']} and cannot be {action}ed; expected {expected}.",
        )
    return loan


def _loan_estimate(
    principal_wei: int,
    rate_bps: int,
    duration_days: int,
    min_collateral_bps: int | None = None,
) -> dict:
    interest = preview_interest_wei(principal_wei, rate_bps, duration_days)
    total_due = principal_wei + interest
    effective_bps = validation.clamp_min_collateral_bps(min_collateral_bps)
    required = required_collateral_wei(principal_wei, effective_bps)
    fee = validation.protocol_fee_wei(interest)
    return {
        "principalWei": str(principal_wei),
        "principalEth": wei_to_eth(principal_wei),
        "interestWei": str(interest),
        "interestEth": wei_to_eth(interest),
        "totalDueWei": str(total_due),
        "totalDueEth": wei_to_eth(total_due),
        "requiredCollateralWei": str(required),
        "requiredCollateralEth": wei_to_eth(required),
        "requiredCollateralBps": effective_bps,
        "defaultRequiredCollateralBps": validation.DEFAULT_MIN_COLLATERAL_BPS,
        "minCollateralFloorBps": validation.MIN_COLLATERAL_FLOOR_BPS,
        "protocolFeeWei": str(fee),
        "protocolFeeEth": wei_to_eth(fee),
        "netInterestToLiquidityWei": str(interest - fee),
        "netInterestToLiquidityEth": wei_to_eth(interest - fee),
        "aprPercent": bps_to_percent(rate_bps),
        "bpsDenominator": validation.BPS_DENOMINATOR,
        "daysPerYear": DAYS_PER_YEAR,
    }


def _error_entry(exc: ApiError) -> dict:
    entry: dict[str, Any] = {"code": exc.code, "message": exc.message}
    if exc.fields:
        entry["fields"] = exc.fields
    return entry


def _simulate(conn, app: Flask, action: str, params: Mapping[str, Any]) -> dict:
    """Dry-run an action against the indexed state. Never writes anything."""
    errors: list[dict] = []
    warnings: list[str] = []
    estimate: dict[str, Any] = {}
    snapshot = db.pool_snapshot(conn)
    paused = bool(snapshot["paused"])
    available = int(snapshot["availableLiquidityWei"])
    now = db.now_ts()

    def capture(fn: Callable[[], None]) -> None:
        try:
            fn()
        except ApiError as exc:
            errors.append(_error_entry(exc))

    if action in ("deposit", "requestLoan", "fundLoan") and paused:
        errors.append(
            {
                "code": "CONFLICT",
                "message": "The pool is paused (PoolPaused); this action would revert until the owner unpauses.",
            }
        )

    if action == "deposit":
        def _deposit() -> None:
            amount = eth_to_wei(params.get("amountEth"), "amountEth")
            validate_deposit_wei(amount)
            total_shares = int(snapshot["totalSharesWei"])
            total_liquidity = int(snapshot["totalLiquidityWei"])
            shares = amount if total_shares == 0 else (amount * total_shares) // max(total_liquidity, 1)
            estimate.update(
                {
                    "amountWei": str(amount),
                    "amountEth": wei_to_eth(amount),
                    "sharesMintedWei": str(shares),
                    "sharesMintedEth": wei_to_eth(shares),
                }
            )
            if total_shares == 0:
                warnings.append(
                    "First deposit: one wei of the minted shares is parked on the contract as "
                    "DEAD_SHARES (the ERC-4626 inflation guard)."
                )

        capture(_deposit)

    elif action == "withdraw":
        def _withdraw() -> None:
            amount = eth_to_wei(params.get("amountEth"), "amountEth")
            if amount == 0:
                raise ValidationError({"amountEth": "must be greater than zero"})
            if amount > available:
                raise ValidationError(
                    {
                        "amountEth": (
                            f"exceeds the pool's free liquidity of {wei_to_eth(available)} ETH "
                            "(liquidity reserved for active loans cannot be withdrawn)"
                        )
                    }
                )
            estimate.update({"amountWei": str(amount), "amountEth": wei_to_eth(amount)})
            warnings.append(
                "withdraw() is allowed while the pool is paused so suppliers can always exit."
            )

        capture(_withdraw)

    elif action == "requestLoan":
        def _request() -> None:
            principal = validate_principal_wei(
                eth_to_wei(params.get("principalEth"), "principalEth")
            )
            rate_bps = validate_rate_bps(params.get("rateBps"))
            duration_days = validate_duration_days(params.get("durationDays"))
            collateral = eth_to_wei(params.get("collateralEth"), "collateralEth")
            policy = collateral_policy(app, conn)
            validate_collateral_wei(
                principal,
                collateral,
                "collateralEth",
                min_collateral_bps=policy["effectiveBps"],
            )
            estimate.update(
                _loan_estimate(principal, rate_bps, duration_days, policy["effectiveBps"])
            )
            estimate["collateralPolicy"] = policy
            if available < principal:
                warnings.append(
                    f"Only {wei_to_eth(available)} ETH of free liquidity is available, so this "
                    f"{wei_to_eth(principal)} ETH request will stay Pending until funded."
                )
            required = required_collateral_wei(principal, policy["effectiveBps"])
            if collateral > required:
                warnings.append(
                    f"Collateral {wei_to_eth(collateral)} ETH exceeds the required "
                    f"{wei_to_eth(required)} ETH; the excess is refunded on settlement."
                )
            if policy["clampedToFloor"]:
                warnings.append(
                    f"The chain reports minCollateralBps = {policy['chainBps']} bps, which is "
                    f"below the immutable floor of {policy['floorBps']} bps; the floor value is "
                    "used so the API never quotes a loan the chain would reject."
                )

        capture(_request)

    elif action == "fundLoan":
        def _fund() -> None:
            loan_id = parse_int(params.get("loanId"), "loanId")
            loan = db.get_loan(conn, loan_id)
            if int(loan["statusCode"]) != LOAN_STATUS_PENDING:
                raise ApiError("CONFLICT", f"Loan {loan_id} is {loan['status']}, not Pending.")
            amount = eth_to_wei(params.get("amountEth"), "amountEth")
            remaining = int(loan["principalWei"]) - int(loan["fundedWei"])
            if amount == 0:
                raise ValidationError({"amountEth": "must be greater than zero"})
            if amount > remaining:
                raise ValidationError(
                    {"amountEth": f"exceeds the remaining {wei_to_eth(remaining)} ETH"}
                )
            estimate.update(
                {
                    "loanId": loan_id,
                    "amountWei": str(amount),
                    "amountEth": wei_to_eth(amount),
                    "remainingAfterWei": str(remaining - amount),
                    "activatesLoan": amount == remaining,
                }
            )

        capture(_fund)

    elif action == "repayLoan":
        def _repay() -> None:
            loan_id = parse_int(params.get("loanId"), "loanId")
            loan = db.get_loan(conn, loan_id)
            if int(loan["statusCode"]) != LOAN_STATUS_ACTIVE:
                raise ApiError("CONFLICT", f"Loan {loan_id} is {loan['status']}, not Active.")
            amount_due, late_fee = amount_due_wei(
                int(loan["principalWei"]), int(loan["interestWei"]), int(loan["dueDate"]), now
            )
            amount = eth_to_wei(params.get("amountEth", wei_to_eth(amount_due)), "amountEth")
            if amount < amount_due:
                raise ValidationError(
                    {"amountEth": f"is below the {wei_to_eth(amount_due)} ETH currently due"}
                )
            breakdown = validation.repayment_breakdown(
                int(loan["principalWei"]), int(loan["interestWei"]), int(loan["dueDate"]), now
            )
            estimate.update(
                {
                    "loanId": loan_id,
                    "amountDueWei": str(amount_due),
                    "amountDueEth": wei_to_eth(amount_due),
                    "lateFeeWei": str(late_fee),
                    "lateFeeEth": wei_to_eth(late_fee),
                    "protocolFeeWei": str(breakdown["feeWei"]),
                    "netInterestToLiquidityWei": str(breakdown["liquidityCreditWei"]),
                    "refundWei": str(max(amount - amount_due, 0)),
                }
            )
            warnings.append(
                "Repayment credits only net interest (interest - protocol fee) plus any late fee "
                "to totalLiquidity; the protocol fee accrues to treasuryBalance and never enters "
                "totalLiquidity (spec section 1)."
            )

        capture(_repay)

    elif action == "cancelLoan":
        def _cancel() -> None:
            loan_id = parse_int(params.get("loanId"), "loanId")
            loan = db.get_loan(conn, loan_id)
            if int(loan["statusCode"]) != LOAN_STATUS_PENDING:
                raise ApiError("CONFLICT", f"Loan {loan_id} is {loan['status']}, not Pending.")
            if int(loan["fundedWei"]) != 0:
                raise ApiError(
                    "CONFLICT",
                    f"Loan {loan_id} already has {wei_to_eth(int(loan['fundedWei']))} ETH funded "
                    "and can no longer be cancelled (NotFunded).",
                )
            if params.get("borrower") and not validation.addresses_equal(
                str(params["borrower"]), loan["borrower"]
            ):
                raise ApiError("CONFLICT", "cancelLoan is borrower-only (NotBorrower).")
            estimate.update(
                {
                    "loanId": loan_id,
                    "collateralRefundWei": str(int(loan["collateralWei"])),
                    "collateralRefundEth": wei_to_eth(int(loan["collateralWei"])),
                }
            )

        capture(_cancel)

    elif action == "liquidate":
        def _liquidate() -> None:
            loan_id = parse_int(params.get("loanId"), "loanId")
            loan = db.get_loan(conn, loan_id)
            if int(loan["statusCode"]) != LOAN_STATUS_ACTIVE:
                raise ApiError("CONFLICT", f"Loan {loan_id} is {loan['status']}, not Active.")
            if now <= int(loan["dueDate"]):
                raise ApiError(
                    "CONFLICT",
                    f"Loan {loan_id} is not overdue yet (due at {loan['dueDate']}).",
                )
            breakdown = liquidation_breakdown(
                int(loan["principalWei"]),
                int(loan["interestWei"]),
                int(loan["collateralWei"]),
                int(loan["dueDate"]),
                now,
            )
            estimate.update({k: str(v) for k, v in breakdown.items()})
            if breakdown["badDebtWei"]:
                warnings.append(
                    f"Shortfall default: {wei_to_eth(breakdown['badDebtWei'])} ETH of principal "
                    "is recorded as totalBadDebt; suppliers are the residual claimant and "
                    "totalLiquidity - reservedLiquidity falls by the same amount."
                )
            else:
                warnings.append(
                    "Suppliers receive min(owed + penalty, collateral); the surplus collateral is "
                    "refunded to the borrower, and totalLiquidity is re-struck at "
                    "totalLiquidity - principal + compensation."
                )

        capture(_liquidate)

    else:  # pragma: no cover - guarded by the route
        raise ApiError("INTERNAL_ERROR", f"unhandled simulate action {action!r}")

    return {
        "action": action,
        "allowed": not errors,
        "errors": errors,
        "warnings": warnings,
        "estimate": estimate,
        "indexed": {
            "availableLiquidityWei": snapshot["availableLiquidityWei"],
            "totalLiquidityWei": snapshot["totalLiquidityWei"],
            "reservedLiquidityWei": snapshot["reservedLiquidityWei"],
            "paused": paused,
        },
        "evaluatedAt": now,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = _env_int("PORT", 5000)
    app = create_app()
    state = app.extensions["microlend"]
    state["logger"].info(
        "starting MicroLend backend",
        extra={
            "context": {
                "url": f"http://{host}:{port}{API_BASE}",
                "chainMode": state["chain"].mode,
                "contractAddress": state["chain"].contract_address,
                "database": app.config["DATABASE_PATH"],
            }
        },
    )
    app.run(host=host, port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
