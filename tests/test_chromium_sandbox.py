"""Chromium sandbox policy: on by default, explicit opt-out only.

See backend/chromium_sandbox.py and docker/SECCOMP.md.
"""

from __future__ import annotations

import ast
import json
import logging
from pathlib import Path

import pytest

from backend import chromium_sandbox as cs

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
LAUNCH_METHODS = {"launch", "launch_persistent_context"}


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------

def test_sandbox_enabled_by_default(monkeypatch):
    monkeypatch.delenv(cs.NO_SANDBOX_ENV, raising=False)
    assert cs.chromium_sandbox_kwargs() == {"chromium_sandbox": True}


@pytest.mark.parametrize("value", ["", "0", "false", "no", "off", "maybe"])
def test_non_truthy_values_keep_sandbox(monkeypatch, value):
    monkeypatch.setenv(cs.NO_SANDBOX_ENV, value)
    assert cs.chromium_sandbox_kwargs() == {"chromium_sandbox": True}


@pytest.mark.parametrize("value", ["1", "true", "TRUE", "yes", "on"])
def test_explicit_opt_out_disables_sandbox_loudly(monkeypatch, caplog, value):
    monkeypatch.setenv(cs.NO_SANDBOX_ENV, value)
    with caplog.at_level(logging.WARNING, logger=cs.__name__):
        assert cs.chromium_sandbox_kwargs() == {"chromium_sandbox": False}
    assert any("WITHOUT its sandbox" in r.getMessage() for r in caplog.records)


def test_sandbox_failure_detection_matches_real_chromium_error():
    real = (
        "BrowserType.launch: Target page, context or browser has been closed\n"
        "Browser logs:\n\nChromium sandboxing failed!\n"
        "[FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+"
    )
    assert cs.is_sandbox_failure(RuntimeError(real))
    assert not cs.is_sandbox_failure(RuntimeError("net::ERR_NAME_NOT_RESOLVED"))


def test_browser_use_blocked_in_docker_without_opt_out(monkeypatch):
    monkeypatch.setenv("JOBSMITH_IN_DOCKER", "1")
    monkeypatch.delenv(cs.NO_SANDBOX_ENV, raising=False)
    with pytest.raises(RuntimeError, match=cs.NO_SANDBOX_ENV):
        cs.ensure_browser_use_sandbox_allowed()
    monkeypatch.setenv(cs.NO_SANDBOX_ENV, "1")
    cs.ensure_browser_use_sandbox_allowed()  # opted out → allowed


def test_browser_use_allowed_outside_docker(monkeypatch):
    monkeypatch.delenv("JOBSMITH_IN_DOCKER", raising=False)
    monkeypatch.delenv(cs.NO_SANDBOX_ENV, raising=False)
    monkeypatch.setattr(cs.os.path, "exists", lambda p: False)
    cs.ensure_browser_use_sandbox_allowed()


# ---------------------------------------------------------------------------
# Every launch site goes through the policy (Playwright defaults
# chromium_sandbox to False and then adds --no-sandbox itself).
# ---------------------------------------------------------------------------

def _launch_calls():
    for path in sorted(BACKEND.rglob("*.py")):
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr in LAUNCH_METHODS
                and "firefox" not in ast.unparse(node.func.value)
                and "webkit" not in ast.unparse(node.func.value)
                and node.keywords  # real Playwright launches always pass kwargs
            ):
                yield path.relative_to(ROOT), node


def test_launch_call_sites_are_discovered():
    # Guard against the AST walk silently matching nothing.
    assert len(list(_launch_calls())) >= 10


def test_every_chromium_launch_uses_sandbox_policy():
    offenders = []
    for rel, node in _launch_calls():
        uses_policy = any(
            kw.arg is None
            and isinstance(kw.value, ast.Call)
            and getattr(kw.value.func, "id", None) == "chromium_sandbox_kwargs"
            for kw in node.keywords
        )
        sets_directly = any(kw.arg == "chromium_sandbox" for kw in node.keywords)
        if not uses_policy or sets_directly:
            offenders.append(f"{rel}:{node.lineno}")
    assert not offenders, f"launch without **chromium_sandbox_kwargs(): {offenders}"


def test_no_hardcoded_no_sandbox_flag():
    offenders = []
    for path in sorted(BACKEND.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Constant) and node.value in ("--no-sandbox", "--no-zygote"):
                offenders.append(f"{path.relative_to(ROOT)}:{node.lineno}")
    assert not offenders, offenders


@pytest.mark.asyncio
async def test_browser_controller_launch_requests_sandbox(monkeypatch):
    """BrowserController (the auto-apply path) asks Playwright for the sandbox."""
    import playwright.async_api as pw_api
    from backend.auto_apply.browser_controller import BrowserController

    monkeypatch.delenv(cs.NO_SANDBOX_ENV, raising=False)
    seen = {}

    class _Page:
        def set_default_timeout(self, *_):
            pass

    class _Ctx:
        pages = []

        async def new_page(self):
            return _Page()

        async def add_init_script(self, *_):
            pass

    class _Browser:
        async def new_context(self, **_):
            return _Ctx()

    class _Chromium:
        async def launch(self, **kwargs):
            seen.update(kwargs)
            return _Browser()

    class _PW:
        chromium = _Chromium()

    class _Starter:
        async def start(self):
            return _PW()

    monkeypatch.setattr(pw_api, "async_playwright", lambda: _Starter())
    ctrl = BrowserController({"auto_apply": {"headless": True}})
    try:
        await ctrl.launch()
    except Exception:
        pass  # later fake-object gaps are irrelevant; only launch kwargs matter
    assert seen.get("chromium_sandbox") is True
    assert "--no-sandbox" not in seen.get("args", [])


# ---------------------------------------------------------------------------
# Seccomp profile shipped for Docker deployments
# ---------------------------------------------------------------------------

PROFILE = ROOT / "docker" / "seccomp-chromium.json"
NS_MASK = 0x7E020000  # CLONE_NEWNS|NEWCGROUP|NEWUTS|NEWIPC|NEWUSER|NEWPID|NEWNET


def _profile():
    return json.loads(PROFILE.read_text())


def test_profile_is_default_deny():
    p = _profile()
    assert p["defaultAction"] == "SCMP_ACT_ERRNO"


def test_profile_namespace_additions_are_exact():
    added = [s for s in _profile()["syscalls"] if "Jobsmith Chromium" in s.get("comment", "")]
    got = sorted((s["names"][0], s["args"][0]["value"], s["args"][0]["valueTwo"]) for s in added)
    assert got == sorted([
        ("clone", NS_MASK, 0x10000000),    # NEWUSER
        ("clone", NS_MASK, 0x70000000),    # NEWUSER|NEWPID|NEWNET
        ("clone", NS_MASK, 0x20000000),    # NEWPID (renderer fork inside sandbox userns)
        ("unshare", NS_MASK, 0x10000000),  # NEWUSER
    ])
    for s in added:
        assert s["action"] == "SCMP_ACT_ALLOW"
        assert s["args"][0]["op"] == "SCMP_CMP_MASKED_EQ"


def test_profile_does_not_unconditionally_allow_privileged_calls():
    risky = {"mount", "umount2", "pivot_root", "setns", "bpf", "ptrace_attach", "keyctl"}
    for s in _profile()["syscalls"]:
        if s["action"] != "SCMP_ACT_ALLOW":
            continue
        gated = s.get("includes", {}).get("caps") or s.get("args")
        assert gated or not (risky & set(s["names"])), s
