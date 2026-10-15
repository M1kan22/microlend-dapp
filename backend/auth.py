"""MetaMask signature login: single-use nonces, ``personal_sign`` recovery, HMAC tokens.

Authentication flow (spec section 3):

1. ``POST /api/auth/nonce {address}``
   The backend mints a single-use random nonce and a human-readable, SIWE-style message,
   stores ``(address, nonce, message, expires_at, used=0)`` in ``auth_nonces`` and returns
   the message.  Nothing is signed yet.
2. The *browser* calls ``personal_sign(message, address)`` via MetaMask.  The private key
   never leaves the extension and is never sent to this backend.
3. ``POST /api/auth/verify {address, signature}``
   The backend replays the EIP-191 digest of the stored message and **recovers** the signer
   address from the signature with the pure-Python secp256k1 implementation below.  If the
   recovered address matches the claimed one, the nonce is burned and a bearer token is
   issued.
4. ``Authorization: Bearer <token>`` is required on every write route.

Why ``ecrecover`` is implemented by hand
----------------------------------------
``eth-keys`` / ``coincurve`` / ``pycryptodome`` must not be installed (assignment
constraint).  secp256k1 recovery only needs modular arithmetic, so the curve is
implemented directly with Python big integers:

* field arithmetic mod ``p`` (affine coordinates — a handful of ``pow(x, -1, p)`` calls per
  signature is negligible at this request rate),
* ``R`` recovered from ``r`` and the parity bit of the recovery id,
* ``Q = r^-1 (sR - zG)``,
* address = last 20 bytes of ``keccak256(Qx || Qy)``,
* plus a full ECDSA verification of the recovered key so a malformed/forged signature is
  rejected rather than silently yielding some other address.

A classic signature-malleability caveat is documented in ``README.md`` under Security notes.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

from keccak import keccak256, personal_sign_digest
from validation import ApiError, ValidationError, validate_address, addresses_equal

# ---------------------------------------------------------------------------
# secp256k1 domain parameters
# ---------------------------------------------------------------------------

P = 2**256 - 2**32 - 977
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
G = (GX, GY)

Point = tuple[int, int]
INFINITY: None = None

NONCE_TTL_SECONDS = 300
TOKEN_TTL_SECONDS = 12 * 60 * 60
MAX_SIGNATURE_HEX_LEN = 132  # 0x + 65 bytes

# Fields a client must never send; kept in one place so the guard is auditable.
PRIVATE_KEY_FIELDS = (
    "privatekey",
    "private_key",
    "secretkey",
    "secret_key",
    "mnemonic",
    "seedphrase",
    "seed_phrase",
    "keystore",
)


class SignatureError(ValueError):
    """Raised when a signature is malformed or cannot be recovered."""


# ---------------------------------------------------------------------------
# Curve arithmetic
# ---------------------------------------------------------------------------


def _inverse(value: int, modulus: int) -> int:
    return pow(value, -1, modulus)


def point_add(left: Point | None, right: Point | None) -> Point | None:
    """Affine point addition on secp256k1 (``None`` is the point at infinity)."""
    if left is None:
        return right
    if right is None:
        return left
    x1, y1 = left
    x2, y2 = right
    if x1 == x2:
        if (y1 + y2) % P == 0:
            return None
        slope = (3 * x1 * x1) * _inverse(2 * y1 % P, P) % P
    else:
        slope = (y2 - y1) * _inverse((x2 - x1) % P, P) % P
    x3 = (slope * slope - x1 - x2) % P
    y3 = (slope * (x1 - x3) - y1) % P
    return (x3, y3)


def point_mul(scalar: int, point: Point | None) -> Point | None:
    """Double-and-add scalar multiplication."""
    scalar %= N
    result: Point | None = None
    addend = point
    while scalar:
        if scalar & 1:
            result = point_add(result, addend)
        addend = point_add(addend, addend)
        scalar >>= 1
    return result


def is_on_curve(point: Point) -> bool:
    x, y = point
    if not (0 <= x < P and 0 <= y < P):
        return False
    return (y * y - (x * x * x + 7)) % P == 0


def public_key_to_address(point: Point) -> str:
    """Uncompressed public key -> EIP-55 checksummed address."""
    from validation import to_checksum_address

    raw = point[0].to_bytes(32, "big") + point[1].to_bytes(32, "big")
    return to_checksum_address("0x" + keccak256(raw)[-20:].hex())


# ---------------------------------------------------------------------------
# Signature parsing / recovery
# ---------------------------------------------------------------------------


def normalize_v(v: int) -> int:
    """Normalise the recovery id from 27/28, 0/1 or an EIP-155 ``v``."""
    if v in (0, 1):
        return v
    if v in (27, 28):
        return v - 27
    if v >= 35:
        return (v - 35) % 2
    raise SignatureError(f"invalid recovery id v={v}")


def parse_signature(signature: Any) -> tuple[int, int, int]:
    """Parse ``0x`` + 65-byte hex into ``(r, s, recid)``."""
    if isinstance(signature, bool) or not isinstance(signature, str):
        raise SignatureError("signature must be a hex string")
    text = signature.strip()
    if text.startswith(("0x", "0X")):
        text = text[2:]
    if not text or len(text) > MAX_SIGNATURE_HEX_LEN:
        raise SignatureError("signature must be 65 bytes of hex")
    try:
        raw = bytes.fromhex(text)
    except ValueError:
        raise SignatureError("signature is not valid hex") from None
    if len(raw) != 65:
        raise SignatureError("signature must be exactly 65 bytes")
    r = int.from_bytes(raw[0:32], "big")
    s = int.from_bytes(raw[32:64], "big")
    recid = normalize_v(raw[64])
    if not 1 <= r < N:
        raise SignatureError("signature r is out of range")
    if not 1 <= s < N:
        raise SignatureError("signature s is out of range")
    return r, s, recid


def _decompress(x: int, parity: int) -> Point:
    """Recover ``y`` from ``x`` and the parity bit (secp256k1 has p ≡ 3 mod 4)."""
    if not 0 <= x < P:
        raise SignatureError("recovery point x is out of range")
    alpha = (pow(x, 3, P) + 7) % P
    beta = pow(alpha, (P + 1) // 4, P)
    if (beta * beta - alpha) % P != 0:
        raise SignatureError("recovery point is not on the curve")
    y = beta if (beta & 1) == parity else P - beta
    if y == 0:
        raise SignatureError("recovery point has y == 0")
    point = (x, y)
    if not is_on_curve(point):
        raise SignatureError("recovery point failed the curve check")
    return point


def ecdsa_verify(message_hash: int, r: int, s: int, public_key: Point) -> bool:
    """Standard ECDSA verification, used to confirm the recovered key really signed."""
    if not 1 <= r < N or not 1 <= s < N:
        return False
    w = _inverse(s, N)
    u1 = (message_hash * w) % N
    u2 = (r * w) % N
    point = point_add(point_mul(u1, G), point_mul(u2, public_key))
    if point is None:
        return False
    return point[0] % N == r


def recover_public_key(message_hash: int, r: int, s: int, recid: int) -> Point:
    """ECIES-style ``ecrecover``: recover the signing public key.

    ``R`` is rebuilt from ``r`` (adding ``N`` when the recovery id has the high bit set,
    which matters for the astronomically rare case ``r + N < P``), then
    ``Q = r^-1 (sR - zG)``.
    """
    x = r + (recid >> 1) * N
    if x >= P:
        raise SignatureError("recovery id is inconsistent with r")
    point_r = _decompress(x, recid & 1)

    r_inv = _inverse(r, N)
    u1 = (-message_hash * r_inv) % N
    u2 = (s * r_inv) % N
    public_key = point_add(point_mul(u1, G), point_mul(u2, point_r))
    if public_key is None:
        raise SignatureError("recovered public key is the point at infinity")
    if not is_on_curve(public_key):
        raise SignatureError("recovered public key is not on the curve")
    if not ecdsa_verify(message_hash, r, s, public_key):
        raise SignatureError("signature does not verify against the recovered public key")
    return public_key


def recover_address(message: str, signature: str) -> str:
    """Recover the EIP-55 address that produced ``personal_sign(message, signature)``."""
    if not isinstance(message, str):
        raise SignatureError("message must be a string")
    r, s, recid = parse_signature(signature)
    digest = personal_sign_digest(message.encode("utf-8"))
    public_key = recover_public_key(int.from_bytes(digest, "big"), r, s, recid)
    return public_key_to_address(public_key)


def verify_personal_signature(address: str, message: str, signature: str) -> bool:
    """True when ``signature`` is a valid ``personal_sign`` of ``message`` by ``address``.

    Address comparison is case-insensitive because MetaMask returns lowercase addresses
    while EIP-55 display form is mixed case.
    """
    try:
        recovered = recover_address(message, signature)
    except SignatureError:
        return False
    return addresses_equal(recovered, address)


# ---------------------------------------------------------------------------
# SIWE-style message
# ---------------------------------------------------------------------------


def build_siwe_message(
    address: str,
    nonce: str,
    issued_at: int,
    expires_at: int,
    chain_id: int,
    domain: str = "127.0.0.1:5000",
    uri: str = "http://127.0.0.1:5000/api",
) -> str:
    """Human-readable login message. Never contains a key or a fund-moving instruction."""
    issued = datetime.fromtimestamp(issued_at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    expires = datetime.fromtimestamp(expires_at, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return "\n".join(
        [
            f"{domain} wants you to sign in with your Ethereum account:",
            address,
            "",
            "Sign this message to authenticate with the MicroLend backend.",
            "This request will not trigger a blockchain transaction or cost any gas.",
            "",
            f"URI: {uri}",
            "Version: 1",
            f"Chain ID: {chain_id}",
            f"Nonce: {nonce}",
            f"Issued At: {issued}",
            f"Expiration Time: {expires}",
        ]
    )


# ---------------------------------------------------------------------------
# Nonce + session persistence
# ---------------------------------------------------------------------------


def issue_nonce(
    conn: sqlite3.Connection,
    address: str,
    *,
    chain_id: int,
    ttl: int = NONCE_TTL_SECONDS,
    now: int | None = None,
) -> dict:
    """Create a single-use nonce for ``address``; earlier unused nonces stay valid until expiry."""
    now = int(time.time()) if now is None else now
    checksum = validate_address(address, "address")
    nonce = secrets.token_hex(16)
    expires_at = now + ttl
    message = build_siwe_message(checksum, nonce, now, expires_at, chain_id)
    conn.execute(
        "INSERT INTO auth_nonces (address, nonce, message, issued_at, expires_at, used) "
        "VALUES (?, ?, ?, ?, ?, 0)",
        (checksum.lower(), nonce, message, now, expires_at),
    )
    conn.commit()
    return {
        "address": checksum,
        "nonce": nonce,
        "message": message,
        "expiresAt": expires_at,
    }


def consume_nonce_and_issue_token(
    conn: sqlite3.Connection,
    address: str,
    signature: str,
    *,
    secret: str,
    chain_id: int,
    token_ttl: int = TOKEN_TTL_SECONDS,
    now: int | None = None,
) -> dict:
    """Verify a ``personal_sign`` signature against the newest live nonce and mint a token."""
    now = int(time.time()) if now is None else now
    checksum = validate_address(address, "address")

    row = conn.execute(
        "SELECT * FROM auth_nonces WHERE address = ? AND used = 0 AND expires_at > ? "
        "ORDER BY id DESC LIMIT 1",
        (checksum.lower(), now),
    ).fetchone()
    if row is None:
        raise ApiError(
            "AUTH_INVALID",
            "No active sign-in nonce for this address. Request a new nonce from "
            "/api/auth/nonce and sign it within 5 minutes.",
        )

    if not verify_personal_signature(checksum, row["message"], signature):
        raise ApiError(
            "AUTH_INVALID",
            "Signature does not match the address that requested the nonce.",
        )

    # Burn the nonce *before* issuing anything (single use, replay-safe).
    conn.execute("UPDATE auth_nonces SET used = 1 WHERE id = ?", (row["id"],))

    token, expires_at = issue_token(conn, checksum, secret=secret, ttl=token_ttl, now=now)
    conn.execute(
        "INSERT INTO users (address, created_at) VALUES (?, ?) "
        "ON CONFLICT(address) DO NOTHING",
        (checksum.lower(), now),
    )
    conn.commit()
    return {"token": token, "address": checksum, "expiresAt": expires_at}


def _sign_token(secret: str, token_id: str, address: str, expires_at: int) -> str:
    payload = f"{token_id}|{address.lower()}|{expires_at}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def issue_token(
    conn: sqlite3.Connection,
    address: str,
    *,
    secret: str,
    ttl: int = TOKEN_TTL_SECONDS,
    now: int | None = None,
) -> tuple[str, int]:
    """Mint a bearer token: ``<token_urlsafe>.<hmac-sha256 over id|address|expiry>``."""
    now = int(time.time()) if now is None else now
    expires_at = now + ttl
    token_id = secrets.token_urlsafe(32)
    signature = _sign_token(secret, token_id, address, expires_at)
    token = f"{token_id}.{signature}"
    conn.execute(
        "INSERT INTO sessions (token, address, issued_at, expires_at, revoked) "
        "VALUES (?, ?, ?, ?, 0)",
        (token, address.lower(), now, expires_at),
    )
    conn.commit()
    return token, expires_at


def resolve_session(conn: sqlite3.Connection, token: str, *, secret: str) -> dict:
    """Validate a bearer token (HMAC + expiry + revocation) and return the session."""
    if not isinstance(token, str) or not token.strip():
        raise ApiError("AUTH_REQUIRED", "Missing bearer token.")
    token = token.strip()
    row = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
    if row is None:
        raise ApiError("AUTH_INVALID", "Unknown or revoked token.")
    if row["revoked"]:
        raise ApiError("AUTH_INVALID", "This token has been revoked; sign in again.")
    now = int(time.time())
    if row["expires_at"] <= now:
        raise ApiError("AUTH_INVALID", "This session has expired; sign in again.")

    token_id = token.rsplit(".", 1)[0]
    expected = _sign_token(secret, token_id, row["address"], row["expires_at"])
    supplied = token.rsplit(".", 1)[-1]
    if not hmac.compare_digest(expected, supplied):
        raise ApiError("AUTH_INVALID", "Token signature is invalid.")

    return {
        "address": row["address"],
        "expiresAt": row["expires_at"],
        "issuedAt": row["issued_at"],
    }


def revoke_session(conn: sqlite3.Connection, token: str) -> None:
    conn.execute("UPDATE sessions SET revoked = 1 WHERE token = ?", (token,))
    conn.commit()


def prune_expired(conn: sqlite3.Connection, now: int | None = None) -> int:
    """Drop expired nonces/sessions. Returns rows removed; keeps the tables tidy."""
    now = int(time.time()) if now is None else now
    removed = conn.execute("DELETE FROM auth_nonces WHERE expires_at <= ?", (now,)).rowcount
    removed += conn.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,)).rowcount
    conn.commit()
    return removed


def find_private_key_fields(body: Any) -> list[str]:
    """Return any key-material field names present in a request body (case-insensitive)."""
    if not isinstance(body, dict):
        return []
    found = []
    for key in body:
        if isinstance(key, str) and key.lower() in PRIVATE_KEY_FIELDS:
            found.append(key)
    return found


def reject_private_key_material(body: Any) -> None:
    """Hard guard: this API never accepts key material (spec section 3, rule 2)."""
    found = find_private_key_fields(body)
    if found:
        raise ValidationError(
            {name: "private key material is never accepted by this API" for name in found},
            "This API never accepts, transmits or stores private keys, mnemonics or "
            "keystore material. Signing happens in MetaMask; send only the signature.",
        )
