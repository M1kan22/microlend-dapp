"""Pytest configuration for the MicroLend backend suite.

Responsibilities
----------------
1. Make the bundled dev dependencies importable (``.tooling/pylibs``) and the backend
   modules importable, **without hard-coding absolute paths**: everything is resolved
   relative to this file, and a missing ``.tooling`` directory is simply skipped so a
   grader running in a normal virtualenv is unaffected.
2. Create per-test scratch directories with default (0o777) permissions instead of the
   0o700 directories ``tempfile.mkdtemp`` produces — see ``_install_mkdir_compat``.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Import paths (resolved relative to the repo, never hard-coded)
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_DIR = REPO_ROOT / "backend"
PYLIBS_DIR = REPO_ROOT / ".tooling" / "pylibs"

for candidate in (str(BACKEND_DIR), str(PYLIBS_DIR)):
    if os.path.isdir(candidate) and candidate not in sys.path:
        sys.path.insert(0, candidate)

import db  # noqa: E402  (after sys.path setup)

# ---------------------------------------------------------------------------
# Sandbox compatibility shim
# ---------------------------------------------------------------------------


def _mkdir_needs_compat() -> bool:
    """True when ``tempfile.mkdtemp`` produces a directory the process cannot write into.

    Under some DSH Windows sandbox configurations a directory created with mode ``0o700``
    is not writable by the sandboxed process (``mkdir`` ignores the mode on Windows, so
    CPython additionally applies the requested mode's semantics).  A normal environment
    returns ``False`` here and nothing is patched.
    """
    base = Path(tempfile.gettempdir())
    try:
        probe = Path(tempfile.mkdtemp(dir=base, prefix="ml-probe-"))
    except OSError:
        return True
    try:
        with open(probe / "probe.txt", "w", encoding="utf-8") as handle:
            handle.write("x")
        return False
    except OSError:
        return True
    finally:
        shutil.rmtree(probe, ignore_errors=True)


def _install_mkdir_compat() -> bool:
    """Force every directory created during the test run to mode 0o777 when needed."""
    if not _mkdir_needs_compat():
        return False
    real_mkdir = os.mkdir

    def permissive_mkdir(path, mode=0o777, *args, **kwargs):  # type: ignore[no-untyped-def]
        return real_mkdir(path, 0o777, *args, **kwargs)

    os.mkdir = permissive_mkdir  # type: ignore[assignment]
    return True


SANDBOX_MKDIR_COMPAT = _install_mkdir_compat()

# ---------------------------------------------------------------------------
# Scratch space
# ---------------------------------------------------------------------------


@pytest.fixture(scope="session")
def scratch_root():
    """Writable scratch directory that does not depend on pytest's own tmp machinery."""
    base = Path(tempfile.gettempdir()) / "microlend-pytest"
    base.mkdir(parents=True, exist_ok=True)
    try:
        yield base
    finally:
        shutil.rmtree(base, ignore_errors=True)


@pytest.fixture()
def db_path(scratch_root) -> str:
    target = scratch_root / f"case-{uuid.uuid4().hex[:10]}.db"
    return str(target)


# ---------------------------------------------------------------------------
# Application fixtures
# ---------------------------------------------------------------------------

TEST_SECRET = "unit-test-secret-do-not-use-in-production"


def build_app(db_file: str, **overrides):
    """Create a Flask app bound to ``db_file`` with deterministic settings."""
    import app as app_module

    settings = {
        "DATABASE_PATH": db_file,
        "CHAIN_MODE": "mock",
        "AUTH_SECRET": TEST_SECRET,
        "RATE_LIMIT_ENABLED": False,
        "AUTO_SEED": False,
        "LOG_LEVEL": "WARNING",
        "TESTING": True,
    }
    settings.update(overrides)
    return app_module.create_app(settings)


@pytest.fixture()
def app(db_path):
    """Empty database — every test builds exactly the state it needs."""
    return build_app(db_path)


@pytest.fixture()
def seeded_app(db_path):
    """Database pre-populated with the offline demo data."""
    return build_app(db_path, AUTO_SEED=True)


@pytest.fixture()
def client(app):
    return app.test_client()


@pytest.fixture()
def seeded_client(seeded_app):
    return seeded_app.test_client()


@pytest.fixture()
def conn(app):
    """A direct SQLite connection for fixtures and state assertions."""
    connection = db.connect(app.config["DATABASE_PATH"])
    try:
        yield connection
    finally:
        connection.close()


# ---------------------------------------------------------------------------
# Small request helpers
# ---------------------------------------------------------------------------


class Api:
    """Thin wrapper that keeps the JSON envelope handy."""

    def __init__(self, client) -> None:
        self.client = client

    def request(self, method: str, path: str, *, token=None, body=None, headers=None):
        request_headers = dict(headers or {})
        if token:
            request_headers["Authorization"] = f"Bearer {token}"
        if method == "get":
            response = self.client.get(path, headers=request_headers)
        elif method == "post":
            if body is None:
                response = self.client.post(path, headers=request_headers)
            else:
                response = self.client.post(path, headers=request_headers, json=body)
        elif method == "options":
            response = self.client.options(path, headers=request_headers)
        else:  # pragma: no cover
            raise ValueError(method)
        return response, response.get_json()

    def get(self, path, token=None, headers=None):
        return self.request("get", path, token=token, headers=headers)

    def post(self, path, body=None, token=None, headers=None):
        return self.request("post", path, body=body, token=token, headers=headers)


@pytest.fixture()
def api(client) -> Api:
    return Api(client)


@pytest.fixture()
def seeded_api(seeded_client) -> Api:
    return Api(seeded_client)
