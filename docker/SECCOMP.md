# Chromium sandbox in Docker

Jobsmith launches Chromium against third-party job sites, and every launch
requests Chromium's sandbox (`backend/chromium_sandbox.py`). Under Docker's
default seccomp profile, a non-root container can't create the user namespace
that sandbox needs, so Chromium aborts with `No usable sandbox!`.

`seccomp-chromium.json` is Docker's default profile (Moby
[`profiles/seccomp/default.json`](https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json),
Apache-2.0, see [LICENSE.moby](LICENSE.moby)) plus four exact-match rules:

| Syscall | Namespace flags allowed (nothing else) | Why Chromium needs it |
|---|---|---|
| `clone` | `CLONE_NEWUSER` | User-namespace capability probe |
| `clone` | `CLONE_NEWUSER\|CLONE_NEWPID\|CLONE_NEWNET` | Starts the sandboxed zygote |
| `clone` | `CLONE_NEWPID` | The zygote forks each renderer into a fresh PID namespace from *inside* its user namespace |
| `unshare` | `CLONE_NEWUSER` | Sandbox setup |

Each rule matches the namespace bits of the flags argument exactly, using the
same mask Moby uses (`0x7E020000`). Cgroup, mount, UTS and IPC namespaces stay
denied. `setns`, `mount`, `pivot_root`, `bpf` and the rest of the default deny
list stay denied, and `clone3` keeps Moby's ENOSYS fallback. NEWPID and NEWNET
still need `CAP_SYS_ADMIN` in the owning user namespace, which the container
process (uid 1001, CapEff=0, `no-new-privileges`) does not have. All four rules
were confirmed necessary: removing any one makes Chromium fail to launch or to
fork a renderer.

## Use

```yaml
services:
  jobsmith:
    security_opt:
      - no-new-privileges:true
      - seccomp=./docker/seccomp-chromium.json   # absolute path on the host
```

Keep the image's non-root user, keep `no-new-privileges`, add no capabilities.
Don't use `apparmor=unconfined`. Docker's `docker-default` AppArmor profile
works, and on hosts with `kernel.apparmor_restrict_unprivileged_userns=1`
(Ubuntu 23.10+), unconfined is exactly what triggers that restriction.

The setuid `chrome_sandbox` helper is deliberately unused. It would need a
root-owned SUID binary in the image *and* dropping `no-new-privileges`.

## Verify

```bash
docker exec <container> sh -c 'for p in $(pgrep -f -- "--type=renderer"); do
  grep -E "^(Seccomp|Seccomp_filters|NoNewPrivs)" /proc/$p/status; readlink /proc/$p/ns/pid; done'
```

A sandboxed renderer shows `Seccomp_filters: 2` (Docker's filter plus Chromium's
own) and a PID namespace different from the backend's. Its command line also
lacks `--no-sandbox`.

## Opting out (not recommended)

If a host can't apply a custom seccomp profile, set
`JOBSMITH_CHROMIUM_NO_SANDBOX=1`. Chromium then runs unsandboxed and logs a
`SECURITY:` warning on every launch. A renderer exploit on any visited page
then runs as the backend user, with read access to config (API keys), the
database, résumés, saved sessions and mounted secrets, plus the container's
network access. The optional browser-use engine always disables the sandbox in
Docker, so it refuses to run there unless this opt-out is set.
