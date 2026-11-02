"""Chromium sandbox policy for every Playwright launch in Jobsmith.

Jobsmith points Chromium at third-party job sites, so a renderer exploit on a
malicious or compromised page must stay inside Chromium's sandbox. With
``--no-sandbox`` the renderer runs as the backend's own user, in the backend's
own PID and network namespaces, with no seccomp-BPF filter. It can read
config.yaml (API keys), the SQLite database, résumés, saved job-site sessions
and any mounted secrets, and it can reach every service on the container's
networks.

Playwright's ``chromium_sandbox`` launch option defaults to **False** and then
appends ``--no-sandbox`` itself. Removing the literal flag is therefore not
enough: every launch must pass ``**chromium_sandbox_kwargs()``.

Docker: the default seccomp profile blocks the user-namespace ``clone`` that
Chromium's sandbox needs. Run the container with the profile shipped in
``docker/seccomp-chromium.json`` (``security_opt: [seccomp=...]``); see
docker/SECCOMP.md. ``no-new-privileges`` and the non-root ``pwuser`` stay as
they are, and no capabilities are added.

Opt-out: if the host truly cannot provide a sandbox (e.g. no seccomp profile
can be configured), set ``JOBSMITH_CHROMIUM_NO_SANDBOX=1``. Every launch then
logs a warning. Never set it on a host that browses untrusted sites unless you
accept that risk.
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

NO_SANDBOX_ENV = "JOBSMITH_CHROMIUM_NO_SANDBOX"

_TRUTHY = {"1", "true", "yes", "on"}

SANDBOX_HELP = (
    "Chromium could not start its sandbox. In Docker, run the container with "
    "security_opt 'seccomp=<path>/seccomp-chromium.json' (shipped in the image "
    "repo under docker/; see docker/SECCOMP.md) and keep the default non-root "
    "user. Do not use apparmor=unconfined: on hosts that restrict unprivileged "
    "user namespaces, that makes things worse. On a Linux desktop with AppArmor "
    "user-namespace restrictions (Ubuntu 23.10+), see "
    "https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md. "
    f"As a last resort, set {NO_SANDBOX_ENV}=1 to run Chromium WITHOUT a sandbox "
    "(renderer exploits then get the backend's privileges, files and network)."
)


def sandbox_disabled() -> bool:
    """True only when the operator explicitly opted out of the sandbox."""
    return os.environ.get(NO_SANDBOX_ENV, "").strip().lower() in _TRUTHY


def chromium_sandbox_kwargs() -> dict:
    """Keyword args for ``chromium.launch`` / ``launch_persistent_context``.

    Sandbox on by default; opting out logs a warning on every launch so it
    can't go unnoticed in the logs.
    """
    if sandbox_disabled():
        logger.warning(
            "SECURITY: launching Chromium WITHOUT its sandbox because %s is set. "
            "A renderer exploit on any visited job site runs with the backend's "
            "user, files (config, database, sessions, secrets) and network access. "
            "Remove %s and configure the seccomp profile in docker/SECCOMP.md instead.",
            NO_SANDBOX_ENV, NO_SANDBOX_ENV,
        )
        return {"chromium_sandbox": False}
    return {"chromium_sandbox": True}


def is_sandbox_failure(exc: BaseException) -> bool:
    """Heuristic: did Playwright/Chromium fail because no sandbox was usable?"""
    msg = str(exc)
    return "sandbox" in msg.lower() and (
        "No usable sandbox" in msg or "sandboxing failed" in msg.lower()
    )


def explain_launch_failure(exc: BaseException) -> None:
    """Log actionable guidance if a launch failed for lack of a sandbox."""
    if is_sandbox_failure(exc):
        logger.error("%s", SANDBOX_HELP)


def ensure_browser_use_sandbox_allowed() -> None:
    """Refuse to run browser-use in Docker unless the operator opted out.

    browser-use 0.13 appends ``--no-sandbox`` (plus ``--no-zygote`` and
    ``--disable-site-isolation-trials``) whenever it detects a container,
    regardless of ``chromium_sandbox``. Rather than patch the vendor
    library, apply the same explicit opt-in policy as every other launch.
    """
    in_docker = bool(os.environ.get("JOBSMITH_IN_DOCKER")) or os.path.exists("/.dockerenv")
    if in_docker and not sandbox_disabled():
        raise RuntimeError(
            "browser-use always disables Chromium's sandbox inside Docker, so it is "
            f"blocked by default. Set {NO_SANDBOX_ENV}=1 to accept running it "
            "unsandboxed, or use the built-in apply engine (USE_BROWSER_USE=false)."
        )
