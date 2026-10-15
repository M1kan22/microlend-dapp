"""Minimal pure-Python Keccak-256 — vendored, zero third-party dependencies.

Why this file exists
--------------------
Python 3.12 ships ``hashlib.sha3_256``, which is **NIST SHA3-256** (FIPS-202, domain
padding ``0x06``).  Ethereum uses the *original* Keccak submission (padding ``0x01``),
which produces different digests:

    hashlib.sha3_256(b"").hexdigest()  -> a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a
    keccak256(b"").hex()               -> c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470

So ``hashlib`` cannot be used for Ethereum hashing and, per the assignment constraints,
``pycryptodome`` / ``eth-keys`` / ``pysha3`` must not be installed.  This module vendors
Keccak-f[1600] (~60 lines of core logic) so the backend can compute:

  * event topic0 selectors (``keccak256("LoanRequested(uint256,address,...)")``),
  * EIP-55 address checksums,
  * the ``\\x19Ethereum Signed Message`` digest used by ``personal_sign`` recovery,
  * ``POOL_ID = keccak256("MICROLEND_POOL_V1")``.

Correctness is pinned by known-answer tests in ``tests/test_api.py``
(``c5d246...`` for the empty input, ``4e0365...`` for ``b"abc"``) and by an independent
cross-check against the ``ethers`` / ``js-sha3`` implementation.
"""

from __future__ import annotations

__all__ = ["keccak256", "keccak256_hex", "event_topic", "KECCAK_EMPTY"]

_MASK64 = (1 << 64) - 1
_ROUNDS = 24

# Round constants RC[i] for Keccak-f[1600].
_RC = (
    0x0000000000000001,
    0x0000000000008082,
    0x800000000000808A,
    0x8000000080008000,
    0x000000000000808B,
    0x0000000080000001,
    0x8000000080008081,
    0x8000000000008009,
    0x000000000000008A,
    0x0000000000000088,
    0x0000000080008009,
    0x000000008000000A,
    0x000000008000808B,
    0x800000000000008B,
    0x8000000000008089,
    0x8000000000008003,
    0x8000000000008002,
    0x8000000000000080,
    0x000000000000800A,
    0x800000008000000A,
    0x8000000080008081,
    0x8000000000008080,
    0x0000000080000001,
    0x8000000080008008,
)

# Rho rotation offsets, indexed _RHO[x][y] (state lane index = x + 5*y).
_RHO = (
    (0, 36, 3, 41, 18),
    (1, 44, 10, 45, 2),
    (62, 6, 43, 15, 61),
    (28, 55, 25, 21, 56),
    (27, 20, 39, 8, 14),
)

# keccak256: rate = 1600 - 2*256 = 1088 bits = 136 bytes; capacity 512 bits.
_RATE = 136
_DIGEST_LEN = 32

KECCAK_EMPTY = bytes.fromhex("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")


def _rotl64(value: int, shift: int) -> int:
    """Rotate a 64-bit lane left by ``shift`` bits."""
    if shift == 0:
        return value & _MASK64
    return ((value << shift) | (value >> (64 - shift))) & _MASK64


def _keccak_f1600(state: list[int]) -> None:
    """In-place Keccak-f[1600] permutation over 25 lanes (index = x + 5*y)."""
    for rnd in range(_ROUNDS):
        # theta
        c = [
            state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
            for x in range(5)
        ]
        d = [c[(x - 1) % 5] ^ _rotl64(c[(x + 1) % 5], 1) for x in range(5)]
        for x in range(5):
            dx = d[x]
            for y in range(5):
                state[x + 5 * y] ^= dx

        # rho + pi
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl64(state[x + 5 * y], _RHO[x][y])

        # chi
        for y in range(5):
            row = 5 * y
            for x in range(5):
                state[row + x] = b[row + x] ^ ((~b[row + (x + 1) % 5]) & b[row + (x + 2) % 5])

        # iota
        state[0] ^= _RC[rnd]


def keccak256(data: bytes) -> bytes:
    """Return the 32-byte Keccak-256 digest of ``data`` (Ethereum variant)."""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("keccak256() requires bytes")

    padded = bytearray(bytes(data))
    # Original Keccak padding: 0x01 ... 0x80 (multi-rate padding, domain 0x01).
    padded.append(0x01)
    while len(padded) % _RATE != 0:
        padded.append(0x00)
    padded[-1] ^= 0x80

    state = [0] * 25
    for offset in range(0, len(padded), _RATE):
        block = padded[offset : offset + _RATE]
        for lane in range(_RATE // 8):
            state[lane] ^= int.from_bytes(block[lane * 8 : lane * 8 + 8], "little")
        _keccak_f1600(state)

    out = bytearray()
    for lane in range(_DIGEST_LEN // 8):
        out += state[lane].to_bytes(8, "little")
    return bytes(out)


def keccak256_hex(data: bytes) -> str:
    """Hex (no ``0x`` prefix) Keccak-256 digest, convenient for tests."""
    return keccak256(data).hex()


def event_topic(signature: str) -> bytes:
    """topic0 for a Solidity event signature, e.g. ``LoanRequested(uint256,...)``."""
    return keccak256(signature.encode("ascii"))


def personal_sign_digest(message: bytes) -> bytes:
    """The digest EIP-191 ``personal_sign`` actually signs.

    ``keccak256("\\x19Ethereum Signed Message:\\n" + str(len(message)) + message)``
    """
    prefix = b"\x19Ethereum Signed Message:\n" + str(len(message)).encode("ascii")
    return keccak256(prefix + message)


# ``personal_sign`` lives here (next to the hash it needs); it is re-exported by auth.py.
__all__.append("personal_sign_digest")
