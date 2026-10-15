"""MicroLend backend API test suite.

Covers, per the acceptance criteria for task-2:

* every route in docs/INTEGRATION_SPEC.md section 3 on its happy path,
* the documented envelope and status codes, and JSON-only error handling,
* auth required / invalid / expired / revoked, and single-use nonces,
* field-level validation errors for each bad input,
* duplicate transaction-hash conflicts, 404s and 405s,
* pagination and filtering,
* mock-chain sync, sender mismatch, reverted transactions and value mismatches,
* exact decimal money handling with no float anywhere,
* keccak256 and ``personal_sign`` recovery pinned against ``ethers.js`` vectors,
* proof that no private key material exists in the production modules.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from io import BytesIO
from pathlib import Path

import pytest

import auth as auth_module
import chain as chain_module
import db
import demo_seed
import validation
from auth import GX, GY, N
from conftest import Api, TEST_SECRET, build_app
from _test_signer import address_for, new_keypair, sign_message
from keccak import keccak256

BACKEND_DIR = Path(__file__).resolve().parents[1]

# ---------------------------------------------------------------------------
# Fixtures produced by ethers.js v6 (Wallet.signMessage) — an independent oracle for
# keccak256 and for EIP-191 personal_sign recovery.  The private keys used to make these
# have been discarded and are deliberately NOT recorded anywhere in this repository.
# ---------------------------------------------------------------------------

ETHER_ADDR_1 = "0x14791697260E4c9A71f18484C9f997B308e59325"
ETHER_ADDR_2 = "0x5d46aC553A974ef992A08eeef0A05990802F01F6"

_SIWE_HEAD = (
    "127.0.0.1:5000 wants you to sign in with your Ethereum account:\n"
    + ETHER_ADDR_1
    + "\n\nSign this message to authenticate with the MicroLend backend.\n"
    "This request will not trigger a blockchain transaction or cost any gas.\n\n"
    "URI: http://127.0.0.1:5000/api\nVersion: 1\nChain ID: 11155111\nNonce: "
)
_SIWE_TAIL = "\nIssued At: 2026-01-01T00:00:00Z\nExpiration Time: 2026-01-01T00:05:00Z"

ETHER_MESSAGE_1 = _SIWE_HEAD + "0123456789abcdef0123456789abcdef" + _SIWE_TAIL
ETHER_MESSAGE_2 = _SIWE_HEAD + "fedcba9876543210fedcba9876543210" + _SIWE_TAIL

ETHER_SIG_1 = (
    "0x1ca63760c2bc74bc52395a60ce34d4ae7e10d0fa9385e14ba77bf90ae38d9640"
    "6ba3f946d55ba5968f51351cc5d5b4db5bc555049696cb2e955463519745ea231c"
)
ETHER_SIG_2 = (
    "0xf0c5aa83d355d8417c6164dc72fb8b2a147e2b7179e14db10b9aa3e4793be545"
    "4f5d04657041bb5805c739f6d6148c047fecea01d51a61541ded95904b2965721b"
)
ETHER_SIG_BY_KEY_2 = (
    "0x71561f2d0cb01facb82978b724aba417713947081cb086b9e80e2a0b1a789122"
    "1fd82704e2e08a5e50cce1484263a0c9a5dba49d0c2aaadfed9ec13c7154fdad1c"
)

ETHER_POOL_ID = "f436b99774be260f1296ed6e4bc1956ff191307f5dc25cc9b4b728140cdf8605"
ETHER_TOPIC_LOAN_REQUESTED = (
    "0x8d8231c5ca949e8570b67f65f1f718af61d960cd7159bc3efcadfc1dbeb552a2"
)

# EIP-55 checksum vectors from the specification itself.
EIP55_VALID = (
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
)
EIP55_INVALID = "0x5Aaeb6053F3E94C9b9A09f33669435E7Ef1BeAed"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def fresh_hash(prefix: str = "tx") -> str:
    """A unique, well-formed hash that is not a mock sentinel (0x00.. / 0xff..)."""
    while True:
        digest = keccak256(f"{prefix}:{uuid.uuid4().hex}".encode()).hex()
        if not digest.startswith(("00", "ff")):
            return "0x" + digest


def assert_envelope(body, ok: bool):
    assert isinstance(body, dict), body
    assert body.get("ok") is ok, body
    assert ("data" in body) is ok
    assert ("error" in body) is (not ok)
    return body


def sign_in(api: Api, private_key: int, address: str) -> str:
    """Full nonce -> sign -> verify handshake; returns the bearer token."""
    response, body = api.post("/api/auth/nonce", {"address": address})
    assert response.status_code == 201, body
    message = assert_envelope(body, True)["data"]["message"]
    signature = sign_message(private_key, message)
    response, body = api.post(
        "/api/auth/verify", {"address": address, "signature": signature}
    )
    assert response.status_code == 200, body
    return assert_envelope(body, True)["data"]["token"]


def add_liquidity(api: Api, token: str, amount_eth: str) -> str:
    tx_hash = fresh_hash("deposit")
    response, body = api.post(
        "/api/transactions/sync",
        {"txHash": tx_hash, "event": "LiquidityDeposited", "amountEth": amount_eth},
        token=token,
    )
    assert response.status_code == 200, body
    return tx_hash


def create_loan(
    api: Api,
    token: str,
    *,
    principal="5",
    rate=1200,
    days=30,
    collateral="5",
    tx_hash=None,
):
    tx_hash = fresh_hash("loan") if tx_hash is None else tx_hash
    response, body = api.post(
        "/api/loans",
        {
            "principalEth": principal,
            "rateBps": rate,
            "durationDays": days,
            "collateralEth": collateral,
            "txHash": tx_hash,
        },
        token=token,
    )
    return response, body, tx_hash


def authenticated(app, api: Api):
    """Create a random wallet, sign in, and return ``(address, token)``."""
    private_key, address = new_keypair()
    return address, sign_in(api, private_key, address)


# ===========================================================================
# 1. Envelope, discovery and global error handling
# ===========================================================================


def test_health_returns_envelope_and_request_id(api, client):
    response, body = api.get("/api/health")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["status"] == "ok"
    assert data["service"] == "microlend-backend"
    assert data["chainMode"] == "mock"
    assert data["chainId"] == 11155111
    assert response.headers.get("X-Request-Id")
    assert response.mimetype == "application/json"


def test_config_exposes_contract_identity_and_limits(api):
    response, body = api.get("/api/config")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["chainId"] == 11155111
    assert data["chainName"] == "Sepolia"
    assert re.match(r"^0x[0-9a-fA-F]{40}$", data["contractAddress"])
    assert data["apiBase"] == "/api"
    assert data["demoMode"] is True
    assert isinstance(data["abi"], list) and len(data["abi"]) > 90
    assert data["contractAbi"] == data["abi"]
    names = {entry.get("name") for entry in data["abi"]}
    for required in ("requestLoan", "repayLoan", "poolStats", "getLoan", "MIN_COLLATERAL_FLOOR_BPS"):
        assert required in names, required
    params = data["params"]
    assert params["minLoanPrincipalWei"] == "10000000000000"
    assert params["maxLoanPrincipalEth"] == "100"
    assert params["maxLoanPrincipalWei"] == "100000000000000000000"
    assert params["maxDurationDays"] == 365
    assert params["maxRateBps"] == 5000
    assert params["minCollateralBps"] == 10000
    assert params["minCollateralFloorBps"] == 5000
    assert params["minDepositWei"] == "1000000000000"
    assert params["feeBps"] == 1000


def test_abi_matches_the_compiled_artifact():
    """backend/contract_abi.json must equal the artifact contract-chain produces."""
    import json

    artifact = BACKEND_DIR.parent / "artifacts" / "MicroLendPool.json"
    if not artifact.exists():
        pytest.skip("artifacts/MicroLendPool.json has not been generated yet")
    compiled = json.loads(artifact.read_text(encoding="utf-8"))["abi"]
    shipped = json.loads((BACKEND_DIR / "contract_abi.json").read_text(encoding="utf-8"))
    assert shipped == compiled


def test_unknown_route_is_json_404(api):
    response, body = api.get("/api/does-not-exist")
    assert response.status_code == 404
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "NOT_FOUND"
    assert response.mimetype == "application/json"


def test_wrong_method_is_json_405(api):
    response, body = api.request("get", "/api/auth/nonce")
    assert response.status_code == 405
    assert assert_envelope(body, False)["error"]["code"] == "NOT_FOUND"
    assert response.mimetype == "application/json"


def test_unhandled_exception_is_json_500(app, client):
    @app.route("/api/__boom")
    def boom():  # pragma: no cover - only used to exercise the handler
        raise RuntimeError("intentional failure")

    response = client.get("/api/__boom")
    assert response.status_code == 500
    assert response.mimetype == "application/json"
    body = assert_envelope(response.get_json(), False)
    assert body["error"]["code"] == "INTERNAL_ERROR"
    assert "intentional failure" not in response.get_data(as_text=True)


def test_malformed_json_body_is_400(client):
    response = client.post(
        "/api/loans/preview", data="{not json", content_type="application/json"
    )
    assert response.status_code == 400
    assert assert_envelope(response.get_json(), False)["error"]["code"] == "VALIDATION_ERROR"
    assert response.mimetype == "application/json"


def test_cors_preflight_is_not_broken(api):
    response, _ = api.request("options", "/api/loans")
    assert response.status_code in (200, 204)
    assert response.status_code != 500


# ===========================================================================
# 2. Keccak-256 and personal_sign recovery (independent ethers.js oracle)
# ===========================================================================


def test_keccak256_known_vectors():
    assert keccak256(b"").hex() == (
        "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"
    )
    assert keccak256(b"abc").hex() == (
        "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
    )
    # NIST SHA3-256 must NOT be used for Ethereum hashing.
    import hashlib

    assert hashlib.sha3_256(b"").hexdigest() != keccak256(b"").hex()


def test_keccak256_matches_ethers_for_pool_id_and_topics():
    assert keccak256(b"MICROLEND_POOL_V1").hex() == ETHER_POOL_ID
    signature = "LoanRequested(uint256,address,uint256,uint256,uint256,uint256,uint256)"
    assert "0x" + keccak256(signature.encode()).hex() == ETHER_TOPIC_LOAN_REQUESTED


def test_event_topic_matches_abi_derived_signature():
    events, _ = chain_module.abi_index(chain_module.load_abi())
    entry = events["LoanRequested"]
    assert chain_module.event_topic0(entry) == ETHER_TOPIC_LOAN_REQUESTED
    assert (
        chain_module.event_signature(entry)
        == "LoanRequested(uint256,address,uint256,uint256,uint256,uint256,uint256)"
    )


@pytest.mark.parametrize(
    "message, signature, expected",
    [
        (ETHER_MESSAGE_1, ETHER_SIG_1, ETHER_ADDR_1),
        (ETHER_MESSAGE_2, ETHER_SIG_2, ETHER_ADDR_1),
        (ETHER_MESSAGE_1, ETHER_SIG_BY_KEY_2, ETHER_ADDR_2),
    ],
)
def test_personal_sign_recovery_matches_ethers(message, signature, expected):
    assert auth_module.recover_address(message, signature).lower() == expected.lower()


def test_recovery_rejects_wrong_address_and_tampered_message():
    assert not auth_module.verify_personal_signature(ETHER_ADDR_2, ETHER_MESSAGE_1, ETHER_SIG_1)
    assert not auth_module.verify_personal_signature(ETHER_ADDR_1, ETHER_MESSAGE_1 + "x", ETHER_SIG_1)
    assert not auth_module.verify_personal_signature(ETHER_ADDR_1, ETHER_MESSAGE_1, "0xdeadbeef")


def test_runtime_signer_round_trips():
    private_key, address = new_keypair()
    message = "MicroLend round-trip check\nnonce: 0x1234"
    signature = sign_message(private_key, message)
    assert len(signature) == 132
    assert auth_module.recover_address(message, signature).lower() == address.lower()
    assert auth_module.verify_personal_signature(address, message, signature)


def test_private_key_derivation_matches_recovery():
    private_key, address = new_keypair()
    assert address_for(private_key).lower() == address.lower()


# ===========================================================================
# 3. Money: exact decimals, no floats
# ===========================================================================


def test_eth_to_wei_and_back_are_exact():
    assert validation.eth_to_wei("0.05") == 50_000_000_000_000_000
    assert validation.eth_to_wei("1") == 10**18
    assert validation.eth_to_wei(".5") == 5 * 10**17
    assert validation.eth_to_wei("0.000001") == 10**12
    assert validation.wei_to_eth(50_000_000_000_000_000) == "0.05"
    assert validation.wei_to_eth(10**18) == "1"
    assert validation.wei_to_eth(0) == "0"
    assert validation.wei_to_eth(1) == "0.000000000000000001"


def test_eth_round_trip_is_lossless_for_awkward_values():
    for text in ("0.1", "0.3", "123.456789012345678", "99999999.000000000000000001"):
        assert validation.wei_to_eth(validation.eth_to_wei(text)) == text


def test_float_and_non_string_amounts_are_rejected():
    for bad in (0.05, 1.0, 5, True, None, ["0.5"]):
        with pytest.raises(validation.ValidationError) as caught:
            validation.eth_to_wei(bad, "amountEth")
        assert "amountEth" in caught.value.fields


@pytest.mark.parametrize(
    "bad",
    ["1e-18", "-1", "+1", "", "   ", "0x10", "1.2.3", "0.1234567890123456789", "abc"],
)
def test_malformed_eth_strings_are_rejected(bad):
    with pytest.raises(validation.ValidationError):
        validation.eth_to_wei(bad, "amountEth")


def test_uint256_scale_amounts_survive_as_text(api, conn):
    """A 100 ETH principal is ~1e20 wei: far beyond SQLite's signed 64-bit INTEGER."""
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "150")
    response, body, _ = create_loan(
        api, token, principal="100", rate=5000, days=365, collateral="100"
    )
    assert response.status_code == 201, body
    loan = assert_envelope(body, True)["data"]
    assert loan["principalWei"] == "100000000000000000000"
    assert loan["principalEth"] == "100"
    row = conn.execute(
        "SELECT principal_wei, typeof(principal_wei) AS kind FROM loans WHERE loan_id = ?",
        (loan["loanId"],),
    ).fetchone()
    assert row["principal_wei"] == "100000000000000000000"
    assert row["kind"] == "text"
    # Re-read through the API to prove the value survived the round trip exactly.
    _, again = api.get(f"/api/loans/{loan['loanId']}")
    assert assert_envelope(again, True)["data"]["principalWei"] == "100000000000000000000"


def test_preview_math_is_exact(api):
    response, body = api.post(
        "/api/loans/preview", {"principalEth": "100", "rateBps": 5000, "durationDays": 365}
    )
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    # 100 ETH at 50% APR for one year == 50 ETH of simple interest.
    assert data["interestWei"] == "50000000000000000000"
    assert data["interestEth"] == "50"
    assert data["totalDueWei"] == "150000000000000000000"
    assert data["totalDueEth"] == "150"
    assert data["requiredCollateralWei"] == "100000000000000000000"
    assert data["requiredCollateralEth"] == "100"
    assert data["aprPercent"] == "50"
    assert data["protocolFeeWei"] == "5000000000000000000"


def test_late_fee_and_protocol_fee_economics():
    principal = validation.eth_to_wei("10")
    interest = validation.preview_interest_wei(principal, 1000, 30)
    assert interest == (principal * 1000 * 30) // (10_000 * 365)
    due = 1_000_000
    assert validation.amount_due_wei(principal, interest, due, due)[1] == 0
    late, late_fee = validation.amount_due_wei(principal, interest, due, due + 86_400)
    assert late_fee == ((principal + interest) * 100) // 10_000
    assert late == principal + interest + late_fee
    breakdown = validation.repayment_breakdown(principal, interest, due, due)
    assert breakdown["feeWei"] == interest // 10
    assert breakdown["netInterestWei"] == interest - interest // 10
    assert breakdown["liquidityCreditWei"] == interest - interest // 10
    assert breakdown["treasuryCreditWei"] == interest // 10


def test_eip55_checksum_vectors():
    for address in EIP55_VALID:
        assert validation.validate_address(address) == address
    with pytest.raises(validation.ValidationError):
        validation.validate_address(EIP55_INVALID)
    # All-lowercase and all-uppercase forms carry no checksum and are normalised instead.
    assert validation.validate_address(EIP55_VALID[0].lower()) == EIP55_VALID[0]


def test_address_validation_rejects_junk():
    for bad in ("0x123", "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "", None, 42):
        with pytest.raises(validation.ValidationError):
            validation.validate_address(bad)
    with pytest.raises(validation.ValidationError):
        validation.validate_address("0x" + "0" * 40)


# ===========================================================================
# 4. Authentication
# ===========================================================================


def test_nonce_then_verify_then_session_then_logout(api):
    private_key, address = new_keypair()
    response, body = api.post("/api/auth/nonce", {"address": address})
    assert response.status_code == 201
    data = assert_envelope(body, True)["data"]
    assert data["address"].lower() == address.lower()
    assert len(data["nonce"]) == 32
    assert data["nonce"] in data["message"]
    assert "Chain ID: 11155111" in data["message"]
    assert "Sign this message" in data["message"]
    assert data["expiresAt"] > int(time.time())

    token = sign_in(api, private_key, address)
    assert token.count(".") == 1 and len(token) > 40

    response, body = api.get("/api/auth/session", token=token)
    assert response.status_code == 200
    session = assert_envelope(body, True)["data"]
    assert session["address"].lower() == address.lower()
    assert session["expiresAt"] > int(time.time())

    response, body = api.post("/api/auth/logout", token=token)
    assert response.status_code == 200
    assert assert_envelope(body, True)["data"]["loggedOut"] is True

    response, body = api.get("/api/auth/session", token=token)
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"


def test_nonce_is_single_use(api):
    private_key, address = new_keypair()
    _, body = api.post("/api/auth/nonce", {"address": address})
    message = body["data"]["message"]
    signature = sign_message(private_key, message)
    first, first_body = api.post(
        "/api/auth/verify", {"address": address, "signature": signature}
    )
    assert first.status_code == 200
    replay, replay_body = api.post(
        "/api/auth/verify", {"address": address, "signature": signature}
    )
    assert replay.status_code == 401
    assert assert_envelope(replay_body, False)["error"]["code"] == "AUTH_INVALID"


def test_verify_without_a_nonce_is_rejected(api):
    private_key, address = new_keypair()
    response, body = api.post(
        "/api/auth/verify", {"address": address, "signature": sign_message(private_key, "x")}
    )
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"


def test_verify_rejects_signature_from_a_different_wallet(api):
    private_key, address = new_keypair()
    _, other_address = new_keypair()
    _, body = api.post("/api/auth/nonce", {"address": address})
    signature = sign_message(private_key, body["data"]["message"])
    response, body = api.post(
        "/api/auth/verify", {"address": other_address, "signature": signature}
    )
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"


@pytest.mark.parametrize("bad", ["0xdeadbeef", "not-hex", "0x" + "11" * 64, "0x" + "00" * 65])
def test_verify_rejects_malformed_signatures(api, bad):
    _, address = new_keypair()
    api.post("/api/auth/nonce", {"address": address})
    response, body = api.post("/api/auth/verify", {"address": address, "signature": bad})
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"


def test_verify_requires_address_and_signature(api):
    response, body = api.post("/api/auth/verify", {})
    assert response.status_code == 400
    fields = assert_envelope(body, False)["error"]["fields"]
    assert set(fields) == {"address", "signature"}


def test_nonce_requires_a_valid_address(api):
    response, body = api.post("/api/auth/nonce", {"address": "nope"})
    assert response.status_code == 400
    assert "address" in assert_envelope(body, False)["error"]["fields"]


def test_ethers_fixture_signature_authenticates_through_the_api(api, conn):
    """A signature produced by real ethers.js must authenticate via the HTTP API."""
    now = int(time.time())
    conn.execute(
        "INSERT INTO auth_nonces (address, nonce, message, issued_at, expires_at, used) "
        "VALUES (?,?,?,?,?,0)",
        (
            ETHER_ADDR_1.lower(),
            "0123456789abcdef0123456789abcdef",
            ETHER_MESSAGE_1,
            now,
            now + 3600,
        ),
    )
    conn.commit()
    response, body = api.post(
        "/api/auth/verify", {"address": ETHER_ADDR_1, "signature": ETHER_SIG_1}
    )
    assert response.status_code == 200, body
    data = assert_envelope(body, True)["data"]
    assert data["address"].lower() == ETHER_ADDR_1.lower()
    assert data["token"]

    # The same signature presented as a different wallet must fail.
    response, body = api.post(
        "/api/auth/verify", {"address": ETHER_ADDR_2, "signature": ETHER_SIG_1}
    )
    assert response.status_code == 401


def test_write_routes_require_a_token(api):
    for method, path, body in (
        ("post", "/api/loans", {"principalEth": "5"}),
        ("post", "/api/loans/1/fund", {"amountEth": "1"}),
        ("post", "/api/loans/1/repay", {"amountEth": "1"}),
        ("post", "/api/loans/1/liquidate", {"txHash": fresh_hash()}),
        ("post", "/api/transactions/sync", {"txHash": fresh_hash()}),
        ("post", "/api/auth/logout", None),
        ("get", "/api/auth/session", None),
    ):
        response, payload = api.request(method, path, body=body)
        assert response.status_code == 401, (path, payload)
        error = assert_envelope(payload, False)["error"]
        assert error["code"] == "AUTH_REQUIRED"
        assert "Authorization" in error["message"] or "Bearer" in error["message"]


def test_invalid_and_tampered_tokens_are_rejected(api):
    for bad in ("garbage", "abc.def", "x" * 60):
        response, body = api.get("/api/auth/session", token=bad)
        assert response.status_code == 401
        assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"

    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    head, signature = token.rsplit(".", 1)
    tampered = head + "." + ("0" if signature[0] != "0" else "1") + signature[1:]
    response, body = api.get("/api/auth/session", token=tampered)
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"


def test_expired_token_is_rejected(api, conn):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    conn.execute(
        "UPDATE sessions SET expires_at = ? WHERE token = ?", (int(time.time()) - 10, token)
    )
    conn.commit()
    response, body = api.get("/api/auth/session", token=token)
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_INVALID"
    assert "expired" in assert_envelope(body, False)["error"]["message"].lower()


def test_private_key_material_is_never_accepted(api):
    secret = "0x" + "ab" * 32
    response, body = api.post(
        "/api/loans/preview",
        {"principalEth": "5", "rateBps": 1000, "durationDays": 30, "privateKey": secret},
    )
    assert response.status_code == 400
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert "privateKey" in error["fields"]
    assert secret not in response.get_data(as_text=True)


# ===========================================================================
# 5. Pool, loans (read), positions
# ===========================================================================


def test_pool_snapshot_shape_on_an_empty_index(api):
    response, body = api.get("/api/pool")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["totalLiquidityEth"] == "0"
    assert data["availableLiquidityEth"] == "0"
    assert data["reservedLiquidityEth"] == "0"
    assert data["loanCount"] == 0
    assert data["paused"] is False
    assert data["chainMode"] == "mock"
    assert data["source"] == "indexer"
    assert data["params"]["minCollateralFloorBps"] == 5000
    assert re.match(r"^0x[0-9a-fA-F]{40}$", data["contractAddress"])


def test_loans_pagination_and_filters(seeded_api):
    response, body = seeded_api.get("/api/loans")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["total"] == 7
    assert len(data["items"]) == 7
    assert data["limit"] == 50 and data["offset"] == 0

    _, page = seeded_api.get("/api/loans?limit=2")
    assert len(assert_envelope(page, True)["data"]["items"]) == 2

    _, last = seeded_api.get("/api/loans?limit=2&offset=6")
    assert len(assert_envelope(last, True)["data"]["items"]) == 1

    for value in ("Active", "active", "2"):
        _, filtered = seeded_api.get(f"/api/loans?status={value}")
        payload = assert_envelope(filtered, True)["data"]
        assert payload["total"] == 3, value
        assert all(item["status"] == "Active" for item in payload["items"])

    _, by_borrower = seeded_api.get(
        f"/api/loans?borrower={demo_seed.BORROWERS['anna']}"
    )
    payload = assert_envelope(by_borrower, True)["data"]
    assert payload["total"] == 2
    assert all(item["borrower"] == demo_seed.BORROWERS["anna"] for item in payload["items"])

    _, bad_limit = seeded_api.get("/api/loans?limit=999")
    assert bad_limit["ok"] is False and "limit" in bad_limit["error"]["fields"]

    _, bad_status = seeded_api.get("/api/loans?status=nonsense")
    assert bad_status["ok"] is False and "status" in bad_status["error"]["fields"]

    _, bad_borrower = seeded_api.get("/api/loans?borrower=0x123")
    assert bad_borrower["ok"] is False and "borrower" in bad_borrower["error"]["fields"]


def test_loan_detail_serialisation(seeded_api):
    response, body = seeded_api.get("/api/loans/1")
    assert response.status_code == 200
    loan = assert_envelope(body, True)["data"]
    assert loan["loanId"] == 1
    assert loan["status"] == "Active" and loan["statusCode"] == 2
    assert loan["principalWei"] == "8000000000000000000"
    assert loan["principalEth"] == "8"
    assert loan["collateralWei"] == "8400000000000000000"
    assert loan["rateBps"] == 1800
    assert loan["aprPercent"] == "18"
    assert loan["durationDays"] == 30
    assert loan["isDemo"] is True
    assert loan["dueDate"] > loan["startTime"]
    assert int(loan["totalDueWei"]) == int(loan["principalWei"]) + int(loan["interestWei"])
    assert loan["secondsUntilDue"] > 0


def test_overdue_loan_reports_a_late_fee(seeded_api):
    _, body = seeded_api.get("/api/loans/4")
    loan = assert_envelope(body, True)["data"]
    assert loan["isOverdue"] is True
    assert int(loan["lateFeeWei"]) > 0
    assert int(loan["totalDueWei"]) == (
        int(loan["principalWei"]) + int(loan["interestWei"]) + int(loan["lateFeeWei"])
    )
    assert loan["secondsUntilDue"] < 0


def test_loan_history_includes_lifecycle_events(seeded_api):
    _, requested = seeded_api.get("/api/loans/1/history")
    items = assert_envelope(requested, True)["data"]["items"]
    assert len(items) == 1
    assert items[0]["eventType"] == "LoanRequested"
    assert items[0]["payload"]["activated"] is True
    assert items[0]["isDemo"] is True

    _, repaid = seeded_api.get("/api/loans/3/history")
    types = [item["eventType"] for item in assert_envelope(repaid, True)["data"]["items"]]
    assert types == ["LoanRequested", "LoanRepaid"]

    _, liquidated = seeded_api.get("/api/loans/6/history")
    payload = assert_envelope(liquidated, True)["data"]["items"][-1]
    assert payload["eventType"] == "LoanLiquidated"
    assert int(payload["payload"]["badDebtWei"]) > 0


def test_loan_and_history_404s(seeded_api):
    for path in ("/api/loans/424242", "/api/loans/424242/history"):
        response, body = seeded_api.get(path)
        assert response.status_code == 404
        assert assert_envelope(body, False)["error"]["code"] == "NOT_FOUND"


def test_positions_aggregates_user_state(seeded_api):
    response, body = seeded_api.get(f"/api/positions/{demo_seed.BORROWERS['anna']}")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["loanCount"] == 2
    assert data["activeLoans"] == 1
    assert data["repaidLoans"] == 1
    assert data["collateralLockedWei"] == "8400000000000000000"
    assert data["collateralLockedEth"] == "8.4"
    assert int(data["outstandingDebtWei"]) > int(data["borrowedTotalWei"]) - int(
        data["repaidTotalWei"]
    )
    assert len(data["loans"]) == 2
    assert data["contractAddress"]


def test_positions_for_an_unknown_wallet_is_empty_but_200(api):
    _, address = new_keypair()
    response, body = api.get(f"/api/positions/{address}")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["loanCount"] == 0
    assert data["outstandingDebtWei"] == "0"
    assert data["loans"] == []


def test_positions_rejects_a_bad_address(api):
    response, body = api.get("/api/positions/0xzzz")
    assert response.status_code == 400
    assert assert_envelope(body, False)["error"]["code"] == "VALIDATION_ERROR"


# ===========================================================================
# 6. Loans (write): create / fund / repay / liquidate
# ===========================================================================


def test_create_loan_requires_authentication(api):
    response, body = api.post(
        "/api/loans",
        {
            "principalEth": "5",
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "5",
            "txHash": fresh_hash(),
        },
    )
    assert response.status_code == 401
    assert assert_envelope(body, False)["error"]["code"] == "AUTH_REQUIRED"


def test_create_loan_is_pending_without_liquidity(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body, tx_hash = create_loan(api, token)
    assert response.status_code == 201
    loan = assert_envelope(body, True)["data"]
    assert loan["status"] == "Pending" and loan["statusCode"] == 1
    assert loan["startTime"] == 0 and loan["dueDate"] == 0
    assert loan["fundedWei"] == "0"
    assert loan["txHashCreated"] == tx_hash
    assert loan["borrower"].lower() == address.lower()
    assert loan["interestWei"] == str(validation.preview_interest_wei(5 * 10**18, 1200, 30))
    assert loan["isDemo"] is False

    _, pool = api.get("/api/pool")
    snapshot = assert_envelope(pool, True)["data"]
    assert snapshot["loanCount"] == 1
    assert snapshot["accumulatedCollateralEth"] == "5"
    assert snapshot["reservedLiquidityEth"] == "0"
    assert snapshot["availableLiquidityEth"] == "0"

    _, history = api.get(f"/api/loans/{loan['loanId']}/history")
    assert assert_envelope(history, True)["data"]["items"][0]["payload"]["activated"] is False


def test_create_loan_activates_when_the_pool_has_liquidity(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    response, body, _ = create_loan(api, token, principal="5", collateral="5.5")
    assert response.status_code == 201, body
    loan = assert_envelope(body, True)["data"]
    assert loan["status"] == "Active" and loan["statusCode"] == 2
    assert loan["fundedWei"] == loan["principalWei"]
    assert loan["startTime"] > 0
    assert loan["dueDate"] == loan["startTime"] + 30 * 86_400

    _, pool = api.get("/api/pool")
    snapshot = assert_envelope(pool, True)["data"]
    assert snapshot["reservedLiquidityEth"] == "5"
    assert snapshot["availableLiquidityEth"] == "45"
    assert snapshot["accumulatedCollateralEth"] == "5.5"


@pytest.mark.parametrize(
    "payload, bad_field",
    [
        ({"principalEth": "0.000001"}, "principalEth"),  # 1e12 < min 1e13
        ({"principalEth": "0"}, "principalEth"),
        ({"principalEth": "101"}, "principalEth"),  # > 100 ETH cap
        ({"rateBps": 5001}, "rateBps"),
        ({"rateBps": -1}, "rateBps"),
        ({"durationDays": 0}, "durationDays"),
        ({"durationDays": 366}, "durationDays"),
        ({"collateralEth": "4.999999999999999999"}, "collateralEth"),  # < 100%
        ({"collateralEth": "0"}, "collateralEth"),
    ],
)
def test_create_loan_field_validation(api, payload, bad_field):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    body = {
        "principalEth": "5",
        "rateBps": 1200,
        "durationDays": 30,
        "collateralEth": "5",
        "txHash": fresh_hash(),
    }
    body.update(payload)
    response, response_body = api.post("/api/loans", body, token=token)
    assert response.status_code == 400, response_body
    error = assert_envelope(response_body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert bad_field in error["fields"], (bad_field, error["fields"])


def test_create_loan_requires_every_field(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post("/api/loans", {}, token=token)
    assert response.status_code == 400
    fields = assert_envelope(body, False)["error"]["fields"]
    assert set(fields) == {
        "principalEth",
        "rateBps",
        "durationDays",
        "collateralEth",
        "txHash",
    }


def test_create_loan_rejects_a_float_amount(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post(
        "/api/loans",
        {
            "principalEth": 0.05,
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "0.05",
            "txHash": fresh_hash(),
        },
        token=token,
    )
    assert response.status_code == 400
    fields = assert_envelope(body, False)["error"]["fields"]
    assert "principalEth" in fields
    assert "float" in fields["principalEth"].lower() or "string" in fields["principalEth"].lower()


def test_duplicate_tx_hash_is_a_conflict(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    response, body, tx_hash = create_loan(api, token)
    assert response.status_code == 201
    before = assert_envelope(body, True)["data"]

    second, second_body, _ = create_loan(api, token, tx_hash=tx_hash)
    assert second.status_code == 409
    error = assert_envelope(second_body, False)["error"]
    assert error["code"] == "CONFLICT"
    assert tx_hash in error["message"]

    _, listing = api.get("/api/loans")
    assert assert_envelope(listing, True)["data"]["total"] == 1
    assert assert_envelope(listing, True)["data"]["items"][0]["loanId"] == before["loanId"]


def test_fund_loan_partial_then_full_activation(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    _, created, _ = create_loan(api, token, principal="5")
    loan_id = assert_envelope(created, True)["data"]["loanId"]

    response, body = api.post(
        f"/api/loans/{loan_id}/fund",
        {"amountEth": "2", "txHash": fresh_hash("fund")},
        token=token,
    )
    assert response.status_code == 200, body
    partial = assert_envelope(body, True)["data"]
    assert partial["status"] == "Pending"
    assert partial["fundedWei"] == "2000000000000000000"

    response, body = api.post(
        f"/api/loans/{loan_id}/fund",
        {"amountEth": "3", "txHash": fresh_hash("fund")},
        token=token,
    )
    assert response.status_code == 200, body
    activated = assert_envelope(body, True)["data"]
    assert activated["status"] == "Active"
    assert activated["fundedWei"] == "5000000000000000000"
    assert activated["dueDate"] == activated["startTime"] + 30 * 86_400

    _, history = api.get(f"/api/loans/{loan_id}/history")
    types = [item["eventType"] for item in assert_envelope(history, True)["data"]["items"]]
    assert types == ["LoanRequested", "LoanFunded", "LoanFunded"]

    # Funding an already-active loan is a state conflict, not a validation error.
    response, body = api.post(
        f"/api/loans/{loan_id}/fund",
        {"amountEth": "1", "txHash": fresh_hash("fund")},
        token=token,
    )
    assert response.status_code == 409
    assert assert_envelope(body, False)["error"]["code"] == "CONFLICT"


def test_fund_loan_overpayment_is_rejected(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    _, created, _ = create_loan(api, token, principal="5")
    loan_id = assert_envelope(created, True)["data"]["loanId"]
    response, body = api.post(
        f"/api/loans/{loan_id}/fund",
        {"amountEth": "6", "txHash": fresh_hash("fund")},
        token=token,
    )
    assert response.status_code == 400
    assert "amountEth" in assert_envelope(body, False)["error"]["fields"]


def test_fund_unknown_loan_is_404(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post(
        "/api/loans/999/fund", {"amountEth": "1", "txHash": fresh_hash()}, token=token
    )
    assert response.status_code == 404
    assert assert_envelope(body, False)["error"]["code"] == "NOT_FOUND"


def test_repay_loan_settles_and_routes_fees(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    _, created, _ = create_loan(api, token, principal="10", rate=1000, days=30, collateral="10")
    loan = assert_envelope(created, True)["data"]
    loan_id = loan["loanId"]
    due = int(loan["totalDueWei"])
    interest = int(loan["interestWei"])
    fee = interest // 10

    response, body = api.post(
        f"/api/loans/{loan_id}/repay",
        {"amountEth": validation.wei_to_eth(due), "txHash": fresh_hash("repay")},
        token=token,
    )
    assert response.status_code == 200, body
    repaid = assert_envelope(body, True)["data"]
    assert repaid["status"] == "Repaid" and repaid["statusCode"] == 3
    assert repaid["txHashRepaid"]

    _, pool = api.get("/api/pool")
    snapshot = assert_envelope(pool, True)["data"]
    assert snapshot["reservedLiquidityEth"] == "0"
    assert snapshot["accumulatedCollateralEth"] == "0"
    assert snapshot["treasuryBalanceWei"] == str(fee)
    assert snapshot["totalFeesCollectedWei"] == str(fee)
    # totalLiquidity must grow by net interest only (spec section 1), never by the fee.
    assert snapshot["totalInterestEarnedWei"] == str(interest)
    assert snapshot["totalLiquidityWei"] == str(50 * 10**18 + (interest - fee))

    response, body = api.post(
        f"/api/loans/{loan_id}/repay",
        {"amountEth": "1", "txHash": fresh_hash("repay")},
        token=token,
    )
    assert response.status_code == 409
    assert assert_envelope(body, False)["error"]["code"] == "CONFLICT"


def test_repay_below_amount_due_is_rejected(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    _, created, _ = create_loan(api, token, principal="10", collateral="10")
    loan_id = assert_envelope(created, True)["data"]["loanId"]
    response, body = api.post(
        f"/api/loans/{loan_id}/repay",
        {"amountEth": "10", "txHash": fresh_hash("repay")},
        token=token,
    )
    assert response.status_code == 400
    fields = assert_envelope(body, False)["error"]["fields"]
    assert "amountEth" in fields
    assert "below" in fields["amountEth"]


def test_liquidate_overdue_loan(api, conn):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    _, created, _ = create_loan(api, token, principal="10", collateral="10")
    loan_id = assert_envelope(created, True)["data"]["loanId"]

    # Not overdue yet -> conflict.
    response, body = api.post(
        f"/api/loans/{loan_id}/liquidate", {"txHash": fresh_hash()}, token=token
    )
    assert response.status_code == 409
    assert "not overdue" in assert_envelope(body, False)["error"]["message"].lower()

    # Force the loan past its due date.
    past = db.now_ts() - 40 * 86_400
    db.update_loan(conn, loan_id, due_date=past, start_time=past - 30 * 86_400)

    response, body = api.post(
        f"/api/loans/{loan_id}/liquidate", {"txHash": fresh_hash()}, token=token
    )
    assert response.status_code == 200, body
    liquidated = assert_envelope(body, True)["data"]
    assert liquidated["status"] == "Liquidated" and liquidated["statusCode"] == 4

    _, history = api.get(f"/api/loans/{loan_id}/history")
    event = assert_envelope(history, True)["data"]["items"][-1]
    assert event["eventType"] == "LoanLiquidated"
    assert int(event["payload"]["owedWei"]) > int(liquidated["principalWei"])

    _, pool = api.get("/api/pool")
    snapshot = assert_envelope(pool, True)["data"]
    assert snapshot["reservedLiquidityEth"] == "0"
    assert snapshot["accumulatedCollateralEth"] == "0"

    # Second liquidation is a state conflict.
    response, body = api.post(
        f"/api/loans/{loan_id}/liquidate", {"txHash": fresh_hash()}, token=token
    )
    assert response.status_code == 409


def test_mock_reverted_transaction_is_rejected(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body, _ = create_loan(api, token, tx_hash="0x00" + "1" * 62)
    assert response.status_code == 400
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert "reverted" in error["message"].lower() or "reverted" in str(error["fields"]).lower()


def test_mock_sender_mismatch_is_rejected(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body, _ = create_loan(api, token, tx_hash="0xff" + "1" * 62)
    assert response.status_code == 400
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert "authenticated wallet" in json.dumps(error).lower()


def test_chain_value_mismatch_is_rejected(app, api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    tx_hash = fresh_hash("mismatch")
    chain = app.extensions["microlend"]["chain"]
    chain.overrides[tx_hash] = {"principal": 1}
    response, body, _ = create_loan(api, token, tx_hash=tx_hash)
    assert response.status_code == 400
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert "txHash" in error["fields"]
    assert "does not match" in error["message"]


@pytest.mark.parametrize("bad", ["0x123", "not-a-hash", "", None, 42, "0x" + "zz" * 32])
def test_invalid_tx_hash_format_is_rejected(api, bad):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    # Post the body directly so an explicit null/empty txHash is not replaced by a default.
    response, body = api.post(
        "/api/loans",
        {
            "principalEth": "5",
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "5",
            "txHash": bad,
        },
        token=token,
    )
    assert response.status_code == 400
    assert "txHash" in assert_envelope(body, False)["error"]["fields"]


def test_loan_lifecycle_survives_a_fresh_app_on_the_same_database(db_path):
    """State is persisted, not process-local: a second app sees the first one's writes."""
    first_app = build_app(db_path, AUTH_SECRET=TEST_SECRET)
    first_api = Api(first_app.test_client())
    private_key, address = new_keypair()
    token = sign_in(first_api, private_key, address)
    add_liquidity(first_api, token, "25")
    _, created, _ = create_loan(first_api, token, principal="4", collateral="4")
    loan_id = assert_envelope(created, True)["data"]["loanId"]

    second_app = build_app(db_path, AUTH_SECRET=TEST_SECRET)
    second_api = Api(second_app.test_client())
    _, body = second_api.get(f"/api/loans/{loan_id}")
    assert assert_envelope(body, True)["data"]["principalWei"] == "4000000000000000000"
    _, pool = second_api.get("/api/pool")
    assert assert_envelope(pool, True)["data"]["totalLiquidityEth"] == "25"


# ===========================================================================
# 7. Transactions and sync
# ===========================================================================


def test_transactions_listing_and_filters(seeded_api):
    response, body = seeded_api.get("/api/transactions")
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["total"] >= 13
    assert all(item["isDemo"] is True for item in data["items"])

    _, deposits = seeded_api.get("/api/transactions?type=deposit")
    payload = assert_envelope(deposits, True)["data"]
    assert payload["total"] == 2
    assert all(item["type"] == "deposit" for item in payload["items"])
    assert all(item["status"] == "confirmed" for item in payload["items"])

    _, by_address = seeded_api.get(
        f"/api/transactions?address={demo_seed.BORROWERS['anna']}"
    )
    payload = assert_envelope(by_address, True)["data"]
    assert payload["total"] >= 2
    assert all(item["address"] == demo_seed.BORROWERS["anna"] for item in payload["items"])

    _, limited = seeded_api.get("/api/transactions?limit=1&offset=1")
    payload = assert_envelope(limited, True)["data"]
    assert len(payload["items"]) == 1 and payload["limit"] == 1 and payload["offset"] == 1

    _, bad = seeded_api.get("/api/transactions?limit=0")
    assert bad["ok"] is False


def test_sync_requires_auth_and_valid_hash(api):
    response, body = api.post("/api/transactions/sync", {"txHash": fresh_hash()})
    assert response.status_code == 401

    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post("/api/transactions/sync", {"txHash": "0x12"}, token=token)
    assert response.status_code == 400
    assert "txHash" in assert_envelope(body, False)["error"]["fields"]


def test_sync_records_a_deposit_and_updates_the_pool(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    tx_hash = fresh_hash("deposit")
    response, body = api.post(
        "/api/transactions/sync",
        {"txHash": tx_hash, "event": "LiquidityDeposited", "amountEth": "12.5"},
        token=token,
    )
    assert response.status_code == 200, body
    transaction = assert_envelope(body, True)["data"]
    assert transaction["txHash"] == tx_hash
    assert transaction["type"] == "deposit"
    assert transaction["amountWei"] == "12500000000000000000"
    assert transaction["amountEth"] == "12.5"
    assert transaction["address"].lower() == address.lower()

    _, pool = api.get("/api/pool")
    snapshot = assert_envelope(pool, True)["data"]
    assert snapshot["totalLiquidityEth"] == "12.5"
    assert snapshot["totalDepositedEth"] == "12.5"
    assert snapshot["availableLiquidityEth"] == "12.5"

    # Re-syncing the same transaction is a replay and must be refused.
    response, body = api.post(
        "/api/transactions/sync",
        {"txHash": tx_hash, "event": "LiquidityDeposited", "amountEth": "12.5"},
        token=token,
    )
    assert response.status_code == 409
    assert assert_envelope(body, False)["error"]["code"] == "CONFLICT"


def test_sync_rejects_an_unknown_event_name(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post(
        "/api/transactions/sync",
        {"txHash": fresh_hash(), "event": "NotAnEvent"},
        token=token,
    )
    assert response.status_code == 400
    assert "event" in assert_envelope(body, False)["error"]["fields"]


def test_sync_of_a_deposit_below_the_minimum_is_rejected(api):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body = api.post(
        "/api/transactions/sync",
        {"txHash": fresh_hash(), "event": "LiquidityDeposited", "amountEth": "0.0000001"},
        token=token,
    )
    assert response.status_code == 400
    assert "amountEth" in assert_envelope(body, False)["error"]["fields"]


# ===========================================================================
# 8. Simulate
# ===========================================================================


def test_simulate_every_action(seeded_api):
    cases = {
        "deposit": {"amountEth": "10"},
        "withdraw": {"amountEth": "1"},
        "requestLoan": {
            "principalEth": "2",
            "rateBps": 900,
            "durationDays": 14,
            "collateralEth": "2",
        },
        "fundLoan": {"loanId": 5, "amountEth": "5"},
        "repayLoan": {"loanId": 1},
        "cancelLoan": {"loanId": 5, "borrower": demo_seed.BORROWERS["dara"]},
        "liquidate": {"loanId": 4},
    }
    for action, params in cases.items():
        response, body = seeded_api.post("/api/simulate", {"action": action, "params": params})
        assert response.status_code == 200, (action, body)
        data = assert_envelope(body, True)["data"]
        assert data["action"] == action
        assert data["allowed"] is True, (action, data["errors"])
        assert data["errors"] == []
        assert isinstance(data["warnings"], list)
        assert isinstance(data["estimate"], dict) and data["estimate"]
        assert "availableLiquidityWei" in data["indexed"]


def test_simulate_repay_describes_fee_routing(seeded_api):
    _, body = seeded_api.post("/api/simulate", {"action": "repayLoan", "params": {"loanId": 1}})
    data = assert_envelope(body, True)["data"]
    text = " ".join(data["warnings"]).lower()
    assert "net interest" in text
    assert "treasurybalance" in text.replace(" ", "")

    estimate = data["estimate"]
    _, loan_body = seeded_api.get("/api/loans/1")
    loan = assert_envelope(loan_body, True)["data"]
    interest = int(loan["interestWei"])
    assert int(estimate["protocolFeeWei"]) == interest // 10
    # fee (to treasury) + net interest + late fee must reconstruct the full income.
    assert (
        int(estimate["protocolFeeWei"]) + int(estimate["netInterestToLiquidityWei"])
        == interest + int(estimate["lateFeeWei"])
    )
    assert int(estimate["amountDueWei"]) == int(loan["totalDueWei"])


def test_simulate_liquidation_shortfall_warning(api, conn):
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    # Collateral == principal, so principal + interest is a guaranteed shortfall.
    _, created, _ = create_loan(api, token, principal="10", collateral="10")
    loan_id = assert_envelope(created, True)["data"]["loanId"]
    past = db.now_ts() - 90 * 86_400
    db.update_loan(conn, loan_id, due_date=past, start_time=past - 30 * 86_400)

    _, body = api.post("/api/simulate", {"action": "liquidate", "params": {"loanId": loan_id}})
    data = assert_envelope(body, True)["data"]
    assert data["allowed"] is True
    assert int(data["estimate"]["badDebtWei"]) > 0
    assert any("baddebt" in warning.lower().replace(" ", "") for warning in data["warnings"])


@pytest.mark.parametrize(
    "action, params, expected_field",
    [
        ("deposit", {"amountEth": "0.0000001"}, "amountEth"),
        ("withdraw", {"amountEth": "999999"}, "amountEth"),
        (
            "requestLoan",
            {"principalEth": "1", "rateBps": 6000, "durationDays": 30, "collateralEth": "1"},
            "rateBps",
        ),
        ("repayLoan", {"loanId": 1, "amountEth": "0.1"}, "amountEth"),
        ("liquidate", {"loanId": 1}, "overdue"),
    ],
)
def test_simulate_reports_blocked_actions_without_writing(seeded_api, action, params, expected_field):
    _, before = seeded_api.get("/api/pool")
    before_snapshot = assert_envelope(before, True)["data"]
    response, body = seeded_api.post("/api/simulate", {"action": action, "params": params})
    assert response.status_code == 200
    data = assert_envelope(body, True)["data"]
    assert data["allowed"] is False
    assert data["errors"], (action, params)
    assert any(
        expected_field in (error.get("fields") or {}) or expected_field in error["message"]
        for error in data["errors"]
    ), (action, data["errors"])
    _, after = seeded_api.get("/api/pool")
    assert assert_envelope(after, True)["data"] == before_snapshot


def test_simulate_rejects_unknown_action_and_bad_params(seeded_api):
    response, body = seeded_api.post("/api/simulate", {"action": "teleport", "params": {}})
    assert response.status_code == 400
    assert "action" in assert_envelope(body, False)["error"]["fields"]

    response, body = seeded_api.post("/api/simulate", {"action": "deposit", "params": "nope"})
    assert response.status_code == 400
    assert "params" in assert_envelope(body, False)["error"]["fields"]


# ---------------------------------------------------------------------------
# Live minCollateralBps: owner-settable on chain, floor 5000, never hard-coded
# ---------------------------------------------------------------------------


def test_rpc_chain_reads_min_collateral_bps_over_eth_call(monkeypatch):
    """CHAIN_MODE=rpc must read the public getter, not a constant."""
    chain = chain_module.RpcChain(
        "0x5FbDB2315678afecb367f032d93F642f64180aa3", 11155111, "http://127.0.0.1:1"
    )
    seen: list[str] = []

    def fake_call(self, method, params=None):  # noqa: ANN001
        seen.append(method)
        if method == "eth_call":
            return "0x" + (5000).to_bytes(32, "big").hex()
        return None

    monkeypatch.setattr(chain_module.JsonRpcClient, "call", fake_call)
    assert chain.min_collateral_bps() == 5000
    assert "eth_call" in seen


def test_json_rpc_requests_include_a_user_agent(monkeypatch):
    client = chain_module.JsonRpcClient("https://rpc.example")
    requests = []

    def fake_urlopen(request, timeout):  # noqa: ANN001
        requests.append(request)
        return BytesIO(b'{"jsonrpc":"2.0","id":1,"result":"0x1"}')

    monkeypatch.setattr(chain_module.urllib.request, "urlopen", fake_urlopen)
    assert client.call("eth_chainId") == "0x1"
    assert requests[0].get_header("User-agent") == "MicroLend/1.0"


def test_rpc_chain_returns_none_when_the_getter_is_unavailable(monkeypatch):
    chain = chain_module.RpcChain(
        "0x5FbDB2315678afecb367f032d93F642f64180aa3", 11155111, "http://127.0.0.1:1"
    )
    monkeypatch.setattr(
        chain_module.JsonRpcClient, "call", lambda self, method, params=None: "0x"
    )
    assert chain.min_collateral_bps() is None

    def exploding(self, method, params=None):  # noqa: ANN001
        raise validation.ApiError("UPSTREAM_ERROR", "down", 502)

    monkeypatch.setattr(chain_module.JsonRpcClient, "call", exploding)
    assert chain.min_collateral_bps() is None


def test_min_collateral_bps_is_clamped_to_the_immutable_floor():
    assert validation.clamp_min_collateral_bps(10_000) == 10_000
    assert validation.clamp_min_collateral_bps(5_000) == 5_000
    # A mis-set / missing value can never drop the API below the contract's floor.
    assert validation.clamp_min_collateral_bps(1) == 5_000
    assert validation.clamp_min_collateral_bps(0) == 5_000
    assert validation.clamp_min_collateral_bps(None) == 10_000
    requirement = validation.collateral_requirement(10**18, 1)
    assert requirement["effectiveBps"] == 5_000
    assert requirement["clampedToFloor"] is True
    assert requirement["requiredCollateralWei"] == 5 * 10**17


def test_mock_collateral_policy_reports_the_indexed_value(api, conn):
    db.set_pool_min_collateral_bps(conn, 7_500)
    _, body = api.get("/api/config")
    params = assert_envelope(body, True)["data"]["params"]
    assert params["minCollateralBps"] == 7_500
    assert params["minCollateralBpsRaw"] == 7_500
    assert params["minCollateralBpsSource"] == "indexer"
    assert params["minCollateralFloorBps"] == 5_000
    assert params["defaultMinCollateralBps"] == 10_000


def test_collateral_below_the_chain_minimum_is_rejected(api, conn):
    """(a) chain reports 10_000 bps -> a 50%-collateral request is a field-level error."""
    db.set_pool_min_collateral_bps(conn, 10_000)
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    response, body, _ = create_loan(api, token, principal="10", collateral="5")
    assert response.status_code == 400, body
    error = assert_envelope(body, False)["error"]
    assert error["code"] == "VALIDATION_ERROR"
    assert "collateralEth" in error["fields"]
    assert "10000 bps" in error["fields"]["collateralEth"]
    assert "InsufficientCollateral" in error["fields"]["collateralEth"]


def test_collateral_at_the_lowered_chain_minimum_is_accepted(api, conn):
    """(b) chain reports 5_000 bps -> the same 50%-collateral request succeeds."""
    db.set_pool_min_collateral_bps(conn, 5_000)
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")

    response, body = api.post(
        "/api/loans/preview", {"principalEth": "10", "rateBps": 1200, "durationDays": 30}
    )
    assert response.status_code == 200
    preview = assert_envelope(body, True)["data"]
    assert preview["requiredCollateralWei"] == "5000000000000000000"
    assert preview["requiredCollateralEth"] == "5"
    assert preview["requiredCollateralBps"] == 5_000
    assert preview["collateralPolicy"]["source"] == "indexer"

    response, body, _ = create_loan(api, token, principal="10", collateral="5")
    assert response.status_code == 201, body
    loan = assert_envelope(body, True)["data"]
    assert loan["collateralWei"] == "5000000000000000000"
    assert loan["status"] == "Active"


def test_preview_warns_between_the_floor_and_the_chain_minimum(api, conn):
    """(c) 60% collateral is below the chain's 100% minimum but above the 50% floor."""
    db.set_pool_min_collateral_bps(conn, 10_000)
    response, body = api.post(
        "/api/loans/preview",
        {
            "principalEth": "10",
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "6",
        },
    )
    assert response.status_code == 200, body
    preview = assert_envelope(body, True)["data"]
    assert preview["collateralSufficient"] is False
    assert len(preview["warnings"]) == 1
    warning = preview["warnings"][0]
    assert "below the pool's current minCollateralBps" in warning
    assert "10000 bps" in warning
    assert preview["requiredCollateralWei"] == "10000000000000000000"
    assert preview["floorCollateralWei"] == "5000000000000000000"

    # At the chain minimum there is nothing to warn about.
    _, ok_body = api.post(
        "/api/loans/preview",
        {
            "principalEth": "10",
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "10",
        },
    )
    ok_preview = assert_envelope(ok_body, True)["data"]
    assert ok_preview["collateralSufficient"] is True
    assert ok_preview["warnings"] == []

    # Below the immutable floor it is a hard error, not a warning.
    response, bad_body = api.post(
        "/api/loans/preview",
        {
            "principalEth": "10",
            "rateBps": 1200,
            "durationDays": 30,
            "collateralEth": "4",
        },
    )
    assert response.status_code == 400
    assert "collateralEth" in assert_envelope(bad_body, False)["error"]["fields"]


def test_lowered_chain_minimum_flows_into_simulate(api, conn):
    db.set_pool_min_collateral_bps(conn, 5_000)
    private_key, address = new_keypair()
    token = sign_in(api, private_key, address)
    add_liquidity(api, token, "50")
    _, body = api.post(
        "/api/simulate",
        {
            "action": "requestLoan",
            "params": {
                "principalEth": "10",
                "rateBps": 1200,
                "durationDays": 30,
                "collateralEth": "5",
            },
        },
    )
    data = assert_envelope(body, True)["data"]
    assert data["allowed"] is True, data["errors"]
    assert data["estimate"]["requiredCollateralWei"] == "5000000000000000000"
    assert data["estimate"]["collateralPolicy"]["effectiveBps"] == 5_000

    # With the default 100% requirement the identical request is refused.
    db.set_pool_min_collateral_bps(conn, 10_000)
    _, blocked = api.post(
        "/api/simulate",
        {
            "action": "requestLoan",
            "params": {
                "principalEth": "10",
                "rateBps": 1200,
                "durationDays": 30,
                "collateralEth": "5",
            },
        },
    )
    blocked_data = assert_envelope(blocked, True)["data"]
    assert blocked_data["allowed"] is False
    assert "collateralEth" in blocked_data["errors"][0]["fields"]


# ===========================================================================
# 9. Rate limiting
# ===========================================================================


def test_rate_limiter_returns_429(db_path):
    app = build_app(
        db_path, RATE_LIMIT_ENABLED=True, RATE_LIMIT_PER_MINUTE=1, RATE_LIMIT_BURST=1
    )
    client = app.test_client()
    first = client.get("/api/health")
    assert first.status_code == 200
    second = client.get("/api/health")
    assert second.status_code == 429
    body = second.get_json()
    assert body["ok"] is False
    assert body["error"]["code"] == "RATE_LIMITED"
    assert second.mimetype == "application/json"
    assert int(second.headers["Retry-After"]) >= 1

    # The limiter is per-IP: a different client address gets its own bucket.
    third = app.test_client()
    response = third.get("/api/health", environ_base={"REMOTE_ADDR": "10.1.1.9"})
    assert response.status_code == 200


def test_rate_limiter_is_disabled_for_normal_runs(api):
    for _ in range(5):
        response, _ = api.get("/api/health")
        assert response.status_code == 200


# ===========================================================================
# 10. Demo seed
# ===========================================================================


def test_demo_seed_populates_offline_data(seeded_api, conn):
    _, pool_body = seeded_api.get("/api/pool")
    snapshot = assert_envelope(pool_body, True)["data"]
    assert snapshot["loanCount"] == 7
    assert snapshot["isDemo"] is True
    assert snapshot["totalDepositedEth"] == "250"
    assert snapshot["reservedLiquidityEth"] == "16.5"
    assert snapshot["accumulatedCollateralEth"] == "37.75"
    assert int(snapshot["availableLiquidityWei"]) > 0
    assert int(snapshot["totalBadDebtWei"]) > 0
    assert int(snapshot["treasuryBalanceWei"]) > 0
    assert snapshot["paused"] is False

    _, loans = seeded_api.get("/api/loans")
    items = assert_envelope(loans, True)["data"]["items"]
    assert len(items) == 7
    assert {item["status"] for item in items} == {
        "Active",
        "Pending",
        "Repaid",
        "Liquidated",
        "Cancelled",
    }

    assert int(conn.execute("SELECT COUNT(*) AS n FROM loans WHERE is_demo = 0").fetchone()["n"]) == 0
    assert (
        int(conn.execute("SELECT COUNT(*) AS n FROM transactions WHERE is_demo = 1").fetchone()["n"])
        >= 13
    )
    # 7 x LoanRequested + 2 LoanRepaid + 2 LoanLiquidated + 2 LoanCancelled-style extras:
    # loan 3 (Repaid) and loan 6 (Liquidated) each add one, loan 7 adds the cancel event.
    assert (
        int(conn.execute("SELECT COUNT(*) AS n FROM loan_events WHERE is_demo = 1").fetchone()["n"])
        == 10
    )


def test_demo_seed_is_internally_consistent(seeded_app, conn):
    report = demo_seed.check_consistency(conn)
    assert report["ok"] is True, report["problems"]
    assert report["problems"] == []
    assert report["loanCount"] == 7
    assert int(report["reservedLiquidityWei"]) == 16500000000000000000
    assert int(report["accumulatedCollateralWei"]) == 37750000000000000000
    # availableLiquidity == totalLiquidity - reservedLiquidity, and every claim is positive.
    assert report["availableLiquidityWei"] == str(
        int(report["totalLiquidityWei"]) - int(report["reservedLiquidityWei"])
    )
    assert int(report["availableLiquidityWei"]) > 0
    assert int(report["visiblePoolBalanceWei"]) > 0


def test_demo_seed_is_idempotent(seeded_app, conn):
    before = db.table_counts(conn)
    summary = demo_seed.ensure_seed(conn)
    assert summary["seeded"] is False
    assert db.table_counts(conn) == before


def test_seed_cli_helpers_work(db_path):
    import seed as seed_module

    summary = seed_module.seed_database(db_path, reset=False)
    assert summary["seeded"] is True
    assert summary["consistency"]["ok"] is True
    again = seed_module.seed_database(db_path, reset=False)
    assert again["seeded"] is False
    forced = seed_module.seed_database(db_path, reset=True)
    assert forced["seeded"] is True
    assert forced["consistency"]["ok"] is True


def test_seeded_loan_ids_are_stable(seeded_api):
    for loan_id in range(1, 8):
        response, body = seeded_api.get(f"/api/loans/{loan_id}")
        assert response.status_code == 200
        assert assert_envelope(body, True)["data"]["loanId"] == loan_id


# ===========================================================================
# 11. Security invariants
# ===========================================================================


HEX64 = re.compile(r"0x[0-9a-fA-F]{64}")


def test_production_modules_contain_no_key_material_or_signing_code():
    """No private key literal and no signing capability in the shipped backend.

    The only 64-hex literals allowed are the public secp256k1 domain parameters
    (``N``, ``Gx``, ``Gy``) in ``auth.py``; those are curve constants, not secrets.
    """
    curve_constants = {
        format(N, "064x"),
        format(GX, "064x"),
        format(GY, "064x"),
    }
    modules = sorted(BACKEND_DIR.glob("*.py"))
    assert modules, "expected backend modules"
    for path in modules:
        source = path.read_text(encoding="utf-8")
        assert "def sign_message" not in source, path.name
        assert "def sign(" not in source, path.name
        assert "def private_key" not in source, path.name
        for match in HEX64.findall(source):
            assert match[2:].lower() in curve_constants, (
                f"{path.name} contains an unexpected 64-hex literal"
            )
    # The guard that rejects key material must exist and be wired into the app.
    assert "def reject_private_key_material" in (BACKEND_DIR / "auth.py").read_text(
        encoding="utf-8"
    )
    assert "reject_private_key_material" in (BACKEND_DIR / "app.py").read_text(
        encoding="utf-8"
    )


def test_private_key_fields_are_recognised_case_insensitively():
    for field in ("privateKey", "PRIVATE_KEY", "secretKey", "mnemonic", "seedPhrase"):
        assert auth_module.find_private_key_fields({field: "x"}) == [field]
    assert auth_module.find_private_key_fields({"address": "x"}) == []
    with pytest.raises(validation.ValidationError):
        auth_module.reject_private_key_material({"mnemonic": "test test test"})


def test_auth_secret_is_never_exposed_by_read_routes(seeded_api, seeded_app):
    secret = seeded_app.config["AUTH_SECRET"]
    assert secret and len(secret) > 10
    for path in ("/api/pool", "/api/loans", "/api/transactions", "/api/config", "/api/health"):
        response, _ = seeded_api.get(path)
        assert response.status_code == 200
        assert secret not in response.get_data(as_text=True), path
        assert "authorization" not in response.get_data(as_text=True).lower(), path


def test_error_messages_never_leak_stack_traces(api):
    response, body = api.post("/api/loans/preview", {"principalEth": "abc"})
    assert response.status_code == 400
    text = response.get_data(as_text=True)
    assert "Traceback" not in text
    assert "backend" not in text.replace("backend/", "")
