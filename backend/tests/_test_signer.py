"""Test-only ECDSA signer.

The production backend can only *recover* an address from a signature; it never signs and
never holds key material.  To exercise the full MetaMask login flow the suite therefore
needs something that can produce ``personal_sign`` signatures.  This module does that with
a **key generated at run time** (``secrets``) that exists only in memory for the duration of
a test:

* no private key literal is stored anywhere in the repository,
* nothing is written to disk or to a log,
* the key is discarded with the test.

Interoperability with real wallets is pinned separately, by the hard-coded signature
fixtures in ``test_api.py`` that were produced by ``ethers.js`` v6 ``Wallet.signMessage``.
"""

from __future__ import annotations

import secrets

from auth import G, N, _inverse, personal_sign_digest, point_mul, public_key_to_address


def new_keypair() -> tuple[int, str]:
    """Return ``(private_key_int, checksummed_address)`` for a fresh random key."""
    private_key = secrets.randbelow(N - 1) + 1
    public_key = point_mul(private_key, G)
    assert public_key is not None
    return private_key, public_key_to_address(public_key)


def address_for(private_key: int) -> str:
    public_key = point_mul(private_key, G)
    assert public_key is not None
    return public_key_to_address(public_key)


def sign_message(private_key: int, message: str) -> str:
    """Produce an EIP-191 ``personal_sign`` signature, low-s normalised like MetaMask."""
    digest = int.from_bytes(personal_sign_digest(message.encode("utf-8")), "big")
    while True:
        nonce = secrets.randbelow(N - 1) + 1
        point = point_mul(nonce, G)
        assert point is not None
        r = point[0] % N
        if r == 0:
            continue
        s = (_inverse(nonce, N) * (digest + r * private_key)) % N
        if s == 0:
            continue
        recovery_id = (point[1] & 1) | (2 if point[0] >= N else 0)
        if s > N // 2:  # EIP-2 low-s canonical form
            s = N - s
            recovery_id ^= 1
        return (
            "0x"
            + r.to_bytes(32, "big").hex()
            + s.to_bytes(32, "big").hex()
            + bytes([recovery_id + 27]).hex()
        )
