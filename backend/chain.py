"""Chain access: raw JSON-RPC (no ``web3``) plus a deterministic offline mock.

Two modes, selected by the ``CHAIN_MODE`` environment variable:

``CHAIN_MODE=rpc``
    Talks to ``RPC_URL`` over plain ``urllib`` JSON-RPC.  Only three methods are needed:
    ``eth_getTransactionReceipt``, ``eth_getTransactionByHash`` and (for dashboards)
    ``eth_call``.  Logs are decoded with the small pure-Python ABI decoder in this module —
    ``web3``/``eth-abi`` are deliberately not installed.

``CHAIN_MODE=mock`` (default)
    Everything the DApp needs is synthesised offline from the submitted payload, so the whole
    application is demonstrable and gradable without a testnet, an RPC endpoint or a wallet.
    Accepted hashes are any ``0x`` + 64 hex characters.  Two prefixes are reserved so the
    failure paths stay testable without a chain:

    * ``0x00...`` — the transaction is reported as **reverted** (``status = 0``);
    * ``0xff...`` — the receipt reports a **different sender**, exercising the
      "authenticated wallet must match the on-chain actor" rejection.

    Tests and demos can also inject an arbitrary decoded payload through
    ``MockChain.overrides[tx_hash]`` to force a value mismatch.

What is validated before anything is persisted (spec section 3):
receipt exists → ``status == 1`` → receipt ``to`` equals the configured pool contract →
``tx.from`` equals the authenticated address → the matching event log exists → the decoded
event values equal the submitted ones.  Any failure is a ``400 VALIDATION_ERROR`` with a
message naming the exact mismatch; an unreachable RPC is a ``502 UPSTREAM_ERROR``.
"""

from __future__ import annotations

import functools
import json
import os
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field as dc_field
from typing import Any, Iterable, Mapping, Sequence

from keccak import keccak256
from validation import (
    ApiError,
    ValidationError,
    addresses_equal,
    to_checksum_address,
)

# ---------------------------------------------------------------------------
# Configuration defaults
# ---------------------------------------------------------------------------

DEFAULT_CHAIN_ID = 11155111
DEFAULT_CHAIN_NAME = "Sepolia"
DEFAULT_EXPLORER = "https://sepolia.etherscan.io"
# Deterministic placeholder used by mock mode so /api/config always exposes a valid address.
MOCK_CONTRACT_ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3"
ZERO_ADDRESS = "0x" + "0" * 40

TX_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$")

ABI_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "contract_abi.json")

# Types this decoder supports. Every event and return value actually used here is static.
_STATIC_UINT = re.compile(r"^uint(\d*)$")
_SUPPORTED_STATIC = ("address", "bool", "bytes32")


def is_tx_hash(value: Any) -> bool:
    return isinstance(value, str) and bool(TX_HASH_RE.match(value))


# ---------------------------------------------------------------------------
# ABI loading + encoding/decoding helpers
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=4)
def _load_abi_cached(path: str | None) -> tuple[dict, ...]:
    with open(path or ABI_PATH, "r", encoding="utf-8") as handle:
        abi = json.load(handle)
    if not isinstance(abi, list):
        raise ApiError("INTERNAL_ERROR", "contract_abi.json must contain a JSON array")
    return tuple(abi)


def load_abi(path: str | None = None) -> list[dict]:
    """Load (and cache) backend/contract_abi.json."""
    return list(_load_abi_cached(path))


def event_signature(entry: Mapping[str, Any]) -> str:
    types = ",".join(item["type"] for item in entry.get("inputs", []))
    return f"{entry['name']}({types})"


def event_topic0(entry: Mapping[str, Any]) -> str:
    return "0x" + keccak256(event_signature(entry).encode("ascii")).hex()


def function_signature(entry: Mapping[str, Any]) -> str:
    types = ",".join(item["type"] for item in entry.get("inputs", []))
    return f"{entry['name']}({types})"


def function_selector(entry: Mapping[str, Any]) -> bytes:
    return keccak256(function_signature(entry).encode("ascii"))[:4]


def abi_index(abi: Sequence[Mapping[str, Any]]) -> tuple[dict, dict]:
    """Return ``(events_by_name, functions_by_name)``."""
    events = {e["name"]: e for e in abi if e.get("type") == "event"}
    functions = {f["name"]: f for f in abi if f.get("type") == "function"}
    return events, functions


def encode_uint(value: int, bits: int = 256) -> bytes:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("encode_uint requires an int")
    if value < 0 or value >= 1 << bits:
        raise ValueError(f"value does not fit in uint{bits}")
    return value.to_bytes(32, "big")


def encode_address(value: str) -> bytes:
    if not isinstance(value, str) or not re.match(r"^0x[0-9a-fA-F]{40}$", value):
        raise ValueError("encode_address requires a 20-byte hex address")
    return bytes(12) + bytes.fromhex(value[2:])


def encode_bool(value: bool) -> bytes:
    return (1 if value else 0).to_bytes(32, "big")


def encode_call(entry: Mapping[str, Any], args: Sequence[Any] = ()) -> str:
    """ABI-encode a call's ``data`` field for the static types this project uses."""
    payload = bytearray(function_selector(entry))
    for item, value in zip(entry.get("inputs", []), args):
        type_ = item["type"]
        if _STATIC_UINT.match(type_):
            payload += encode_uint(int(value), int(_STATIC_UINT.match(type_).group(1) or 256))
        elif type_ == "address":
            payload += encode_address(value)
        elif type_ == "bool":
            payload += encode_bool(bool(value))
        else:
            raise ValueError(f"encode_call does not support type {type_!r}")
    return "0x" + payload.hex()


def _decode_static_word(type_: str, word: bytes) -> Any:
    if _STATIC_UINT.match(type_):
        return int.from_bytes(word, "big")
    if type_ == "bool":
        return bool(int.from_bytes(word, "big"))
    if type_ == "address":
        return to_checksum_address("0x" + word[12:].hex())
    if type_ == "bytes32":
        return "0x" + word.hex()
    if type_ == "string" or type_.endswith("]"):
        # No MicroLend event uses dynamic types; fail loudly instead of mis-decoding.
        raise ApiError(
            "UPSTREAM_ERROR",
            f"ABI decoding of dynamic type {type_!r} is not supported by this decoder",
            502,
        )
    raise ApiError("UPSTREAM_ERROR", f"unsupported ABI type {type_!r}", 502)


def decode_outputs(types: Sequence[str], data: str) -> list[Any]:
    """Decode a static head-only return payload (used for ``eth_call`` on ``poolStats``)."""
    raw = bytes.fromhex(data[2:] if data.startswith("0x") else data)
    words = [raw[i : i + 32] for i in range(0, len(raw), 32)]
    if len(words) < len(types):
        raise ApiError("UPSTREAM_ERROR", "eth_call returned a short payload", 502)
    return [_decode_static_word(t, words[i]) for i, t in enumerate(types)]


@dataclass
class DecodedEvent:
    name: str
    address: str
    values: dict[str, Any]
    log_index: int


def decode_event_log(events: Mapping[str, Mapping[str, Any]], log: Mapping[str, Any]) -> DecodedEvent | None:
    """Decode one log entry against the ABI event table; ``None`` when it is not a match."""
    topics = log.get("topics") or []
    if not topics:
        return None
    topic0 = topics[0].lower()
    entry = None
    for candidate in events.values():
        if event_topic0(candidate).lower() == topic0:
            entry = candidate
            break
    if entry is None:
        return None

    inputs = entry.get("inputs", [])
    indexed = [item for item in inputs if item.get("indexed")]
    plain = [item for item in inputs if not item.get("indexed")]
    if len(topics) - 1 != len(indexed):
        return None
    if len(indexed) > 3:
        return None

    values: dict[str, Any] = {}
    for item, topic in zip(indexed, topics[1:]):
        word = bytes.fromhex(topic[2:] if topic.startswith("0x") else topic)
        if len(word) != 32:
            return None
        values[item["name"]] = _decode_static_word(item["type"], word)

    raw = bytes.fromhex(log.get("data", "0x")[2:])
    words = [raw[i : i + 32] for i in range(0, len(raw), 32)]
    if len(words) != len(plain):
        return None
    for item, word in zip(plain, words):
        values[item["name"]] = _decode_static_word(item["type"], word)

    return DecodedEvent(
        name=entry["name"],
        address=to_checksum_address(log.get("address", ZERO_ADDRESS)),
        values=values,
        log_index=int(log.get("logIndex", 0), 16) if isinstance(log.get("logIndex"), str) else int(log.get("logIndex") or 0),
    )


# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class ChainEvent:
    """A verified, decoded chain event that is safe to persist."""

    event: str
    tx_hash: str
    block_number: int
    log_index: int
    contract: str
    sender: str
    status: int
    values: dict[str, Any]
    mode: str
    gas_used: int | None = None
    raw_log: dict | None = dc_field(default=None)


# ---------------------------------------------------------------------------
# JSON-RPC transport (no web3)
# ---------------------------------------------------------------------------


class JsonRpcClient:
    """Minimal JSON-RPC 2.0 client over ``urllib`` (stdlib only)."""

    def __init__(self, url: str, timeout: float = 12.0) -> None:
        if not url:
            raise ApiError("UPSTREAM_ERROR", "RPC_URL is not configured for CHAIN_MODE=rpc", 502)
        self.url = url
        self.timeout = timeout
        self._ids = 0

    def call(self, method: str, params: Sequence[Any] | None = None) -> Any:
        self._ids += 1
        body = json.dumps(
            {"jsonrpc": "2.0", "id": self._ids, "method": method, "params": list(params or [])}
        ).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise ApiError(
                "UPSTREAM_ERROR", f"RPC endpoint returned HTTP {exc.code} for {method}", 502
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise ApiError(
                "UPSTREAM_ERROR", f"Cannot reach the RPC endpoint for {method}: {exc}", 502
            ) from None
        except ValueError:
            raise ApiError("UPSTREAM_ERROR", f"RPC endpoint returned invalid JSON for {method}", 502) from None

        if isinstance(payload, dict) and payload.get("error"):
            error = payload["error"]
            raise ApiError(
                "UPSTREAM_ERROR",
                f"RPC error for {method}: {error.get('message', error)}",
                502,
            )
        return payload.get("result") if isinstance(payload, dict) else None

    def chain_id(self) -> int:
        return int(self.call("eth_chainId"), 16)

    def block_number(self) -> int:
        return int(self.call("eth_blockNumber"), 16)


# ---------------------------------------------------------------------------
# Chain clients
# ---------------------------------------------------------------------------


class BaseChain:
    mode = "base"

    def __init__(self, contract_address: str, chain_id: int) -> None:
        self.contract_address = to_checksum_address(contract_address)
        self.chain_id = chain_id
        self.events, self.functions = abi_index(load_abi())

    # -- shared validation helpers -----------------------------------------

    def _check_hash(self, tx_hash: Any, field: str = "txHash") -> str:
        if not is_tx_hash(tx_hash):
            raise ValidationError(
                {field: "must be a 32-byte transaction hash (0x + 64 hex characters)"}
            )
        return tx_hash

    def _check_sender(self, sender: Any, actor: str) -> str:
        if not isinstance(sender, str) or not addresses_equal(sender, actor):
            raise ValidationError(
                {
                    "txHash": (
                        "the transaction sender "
                        f"{sender or 'unknown'} does not match the authenticated wallet "
                        f"{actor}; the backend only indexes actions by the actor who signed them"
                    )
                }
            )
        return sender

    def _check_contract(self, to: Any) -> str:
        if not isinstance(to, str) or not addresses_equal(to, self.contract_address):
            raise ValidationError(
                {
                    "txHash": (
                        f"the transaction was not sent to the MicroLend pool "
                        f"({self.contract_address}); got {to or 'contract creation'}"
                    )
                }
            )
        return to

    def _check_status(self, status: Any) -> int:
        if status is None:
            raise ValidationError({"txHash": "the receipt has no status field"})
        value = int(status, 16) if isinstance(status, str) else int(status)
        if value != 1:
            raise ValidationError(
                {"txHash": "the transaction reverted on chain (status 0); nothing was indexed"}
            )
        return value

    def _match_values(
        self, decoded: Mapping[str, Any], expectations: Mapping[str, Any]
    ) -> None:
        """Every submitted value must equal the value the chain actually emitted."""
        mismatches: dict[str, str] = {}
        for key, expected in expectations.items():
            if key not in decoded:
                mismatches[key] = "is not part of the emitted event"
                continue
            actual = decoded[key]
            if isinstance(expected, str) and expected.startswith("0x"):
                if not addresses_equal(actual, expected):
                    mismatches[key] = f"the chain emitted {actual}, the request said {expected}"
            elif isinstance(expected, bool) or isinstance(actual, bool):
                if bool(actual) != bool(expected):
                    mismatches[key] = f"the chain emitted {actual}, the request said {expected}"
            elif actual != expected:
                mismatches[key] = f"the chain emitted {actual}, the request said {expected}"
        if mismatches:
            raise ValidationError(
                {"txHash": "the transaction does not match the submitted values"},
                "The decoded event does not match the submitted payload: "
                + "; ".join(f"{k} {v}" for k, v in sorted(mismatches.items())),
            )

    # -- public API --------------------------------------------------------

    def verify_event(
        self,
        tx_hash: str,
        event_name: str,
        actor: str,
        expectations: Mapping[str, Any] | None = None,
        hints: Mapping[str, Any] | None = None,
    ) -> ChainEvent:
        raise NotImplementedError

    def pool_stats(self) -> dict | None:
        """Optional live ``poolStats()`` read; ``None`` when the mode cannot provide it."""
        return None

    def min_collateral_bps(self) -> int | None:
        """Live ``minCollateralBps`` getter; ``None`` when the mode cannot read a chain.

        The parameter is owner-settable (floor 5000), so the API must not hard-code it.
        """
        return None

    def health(self) -> dict:
        return {"mode": self.mode, "chainId": self.chain_id, "contractAddress": self.contract_address}


class MockChain(BaseChain):
    """Offline deterministic chain: synthesises the event from the submitted payload."""

    mode = "mock"

    def __init__(self, contract_address: str = MOCK_CONTRACT_ADDRESS, chain_id: int = DEFAULT_CHAIN_ID) -> None:
        super().__init__(contract_address, chain_id)
        # tx_hash -> partial/complete value override, used by tests and demos to force a
        # decoded-value mismatch without a live chain.
        self.overrides: dict[str, dict] = {}

    # Reserved hash prefixes so failure paths are reachable offline.
    REVERTED_PREFIX = "0x00"
    IMPERSONATED_PREFIX = "0xff"

    def _synthetic_block(self, tx_hash: str) -> int:
        return 1_000_000 + (int(tx_hash, 16) % 900_000)

    def verify_event(
        self,
        tx_hash: str,
        event_name: str,
        actor: str,
        expectations: Mapping[str, Any] | None = None,
        hints: Mapping[str, Any] | None = None,
    ) -> ChainEvent:
        tx_hash = self._check_hash(tx_hash)
        entry = self.events.get(event_name)
        if entry is None:
            raise ApiError("INTERNAL_ERROR", f"unknown event {event_name!r} in the ABI")

        # 0x00... is reported as a reverted transaction.
        if tx_hash.lower().startswith(self.REVERTED_PREFIX):
            raise ValidationError(
                {"txHash": "the demo transaction is marked reverted (status 0); nothing was indexed"}
            )

        sender = actor
        if tx_hash.lower().startswith(self.IMPERSONATED_PREFIX):
            # Simulate a signature mismatch: the receipt's sender is somebody else.
            sender = "0x00000000000000000000000000000000DeaDBeef".lower()
        self._check_sender(sender, actor)

        values: dict[str, Any] = dict(expectations or {})
        values.update(hints or {})
        values.update(self.overrides.get(tx_hash, {}))
        for item in entry.get("inputs", []):
            values.setdefault(item["name"], 0 if item["type"] != "address" else ZERO_ADDRESS)

        self._match_values(values, expectations or {})
        return ChainEvent(
            event=event_name,
            tx_hash=tx_hash,
            block_number=self._synthetic_block(tx_hash),
            log_index=0,
            contract=self.contract_address,
            sender=sender,
            status=1,
            values=values,
            mode=self.mode,
            gas_used=21_000 + (int(tx_hash, 16) % 100_000),
        )

    def health(self) -> dict:
        return {
            "mode": self.mode,
            "chainId": self.chain_id,
            "contractAddress": self.contract_address,
            "note": (
                "CHAIN_MODE=mock: transactions are synthesised offline from the submitted "
                "payload. Demo hashes are 0x + 64 hex characters; 0x00... marks a reverted "
                "transaction and 0xff... marks a sender mismatch."
            ),
        }


class RpcChain(BaseChain):
    """Live chain access over raw JSON-RPC."""

    mode = "rpc"

    def __init__(
        self,
        contract_address: str,
        chain_id: int,
        rpc_url: str,
        timeout: float = 12.0,
    ) -> None:
        super().__init__(contract_address, chain_id)
        self.rpc = JsonRpcClient(rpc_url, timeout=timeout)

    def verify_event(
        self,
        tx_hash: str,
        event_name: str,
        actor: str,
        expectations: Mapping[str, Any] | None = None,
        hints: Mapping[str, Any] | None = None,
    ) -> ChainEvent:
        tx_hash = self._check_hash(tx_hash)
        entry = self.events.get(event_name)
        if entry is None:
            raise ApiError("INTERNAL_ERROR", f"unknown event {event_name!r} in the ABI")

        receipt = self.rpc.call("eth_getTransactionReceipt", [tx_hash])
        if not receipt:
            raise ValidationError(
                {"txHash": "no receipt found for this hash; it may still be pending or unknown"}
            )
        self._check_status(receipt.get("status"))
        self._check_contract(receipt.get("to"))

        sender = receipt.get("from")
        if not sender:
            transaction = self.rpc.call("eth_getTransactionByHash", [tx_hash]) or {}
            sender = transaction.get("from")
        self._check_sender(sender, actor)

        decoded_events = []
        for log in receipt.get("logs") or []:
            decoded = decode_event_log(self.events, log)
            if decoded is not None and addresses_equal(decoded.address, self.contract_address):
                decoded_events.append((decoded, log))

        match = next((pair for pair in decoded_events if pair[0].name == event_name), None)
        if match is None:
            seen = ", ".join(sorted({d.name for d, _ in decoded_events})) or "none"
            raise ValidationError(
                {
                    "txHash": (
                        f"the transaction did not emit {event_name}; events found in this "
                        f"transaction: {seen}"
                    )
                }
            )
        decoded, log = match
        self._match_values(decoded.values, expectations or {})

        gas_used = receipt.get("gasUsed")
        return ChainEvent(
            event=decoded.name,
            tx_hash=tx_hash,
            block_number=int(receipt.get("blockNumber") or 0, 16)
            if isinstance(receipt.get("blockNumber"), str)
            else int(receipt.get("blockNumber") or 0),
            log_index=decoded.log_index,
            contract=decoded.address,
            sender=sender,
            status=1,
            values=decoded.values,
            mode=self.mode,
            gas_used=int(gas_used, 16) if isinstance(gas_used, str) else (int(gas_used) if gas_used else None),
            raw_log=log,
        )

    def pool_stats(self) -> dict | None:
        """Read ``poolStats()`` from the live pool (12 static outputs)."""
        entry = self.functions.get("poolStats")
        if entry is None:
            return None
        data = encode_call(entry)
        result = self.rpc.call("eth_call", [{"to": self.contract_address, "data": data}, "latest"])
        if not result or result == "0x":
            return None
        outputs = entry.get("outputs", [])
        values = decode_outputs([item["type"] for item in outputs], result)
        return {item["name"]: value for item, value in zip(outputs, values)}

    def min_collateral_bps(self) -> int | None:
        """Read the owner-settable ``minCollateralBps()`` getter over ``eth_call``."""
        entry = self.functions.get("minCollateralBps")
        if entry is None:
            return None
        data = encode_call(entry)
        try:
            result = self.rpc.call(
                "eth_call", [{"to": self.contract_address, "data": data}, "latest"]
            )
        except ApiError:
            return None
        if not result or result == "0x":
            return None
        values = decode_outputs([item["type"] for item in entry.get("outputs", [])], result)
        return int(values[0]) if values else None

    def health(self) -> dict:
        try:
            head = self.rpc.block_number()
            ok = True
        except ApiError as exc:
            return {
                "mode": self.mode,
                "chainId": self.chain_id,
                "contractAddress": self.contract_address,
                "rpcReachable": False,
                "error": exc.message,
            }
        return {
            "mode": self.mode,
            "chainId": self.chain_id,
            "contractAddress": self.contract_address,
            "rpcReachable": ok,
            "blockNumber": head,
        }


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def build_chain(
    *,
    mode: str | None = None,
    contract_address: str | None = None,
    rpc_url: str | None = None,
    chain_id: int | None = None,
    timeout: float = 12.0,
) -> BaseChain:
    """Construct the configured chain client (env-driven by default)."""
    mode = (mode or os.environ.get("CHAIN_MODE") or "mock").strip().lower()
    contract_address = contract_address or os.environ.get("MICROLEND_CONTRACT_ADDRESS") or ""
    rpc_url = rpc_url or os.environ.get("RPC_URL") or ""
    if chain_id is None:
        raw_chain = os.environ.get("CHAIN_ID")
        chain_id = int(raw_chain) if raw_chain and raw_chain.isdigit() else DEFAULT_CHAIN_ID

    if mode == "rpc":
        if not contract_address or contract_address == ZERO_ADDRESS:
            raise ApiError(
                "UPSTREAM_ERROR",
                "CHAIN_MODE=rpc requires MICROLEND_CONTRACT_ADDRESS to be set to the deployed pool",
                502,
            )
        return RpcChain(contract_address, chain_id, rpc_url, timeout=timeout)
    if mode != "mock":
        raise ApiError(
            "INTERNAL_ERROR", f"CHAIN_MODE must be 'mock' or 'rpc', got {mode!r}"
        )
    return MockChain(contract_address or MOCK_CONTRACT_ADDRESS, chain_id)


def explorer_base() -> str:
    return os.environ.get("EXPLORER_BASE") or DEFAULT_EXPLORER
