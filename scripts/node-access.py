#!/usr/bin/env python3
"""Make sure this machine can SSH into every node without a password (the other node scripts need it).

    scripts/node-access.py              # check every node in scripts/nodes.txt; ssh-copy-id where needed
    scripts/node-access.py --check      # only report, change nothing (non-interactive; safe for agents)
    scripts/node-access.py node2        # one node (name, MAC, or a host/IP)
    scripts/node-access.py --key ~/.ssh/other.pub

For each node: find it by MAC (fp_nodes.py), try a key-based login (BatchMode). If that fails, run
`ssh-copy-id arduino@<node>`, which asks for the board's `arduino` password ONCE and installs the public
key in ~/.ssh/authorized_keys on the board. Needs a human at the terminal for that password: an agent should
run `--check` itself and ask the user to run the script (in Claude Code: `! scripts/node-access.py`).
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fp_nodes import SSH, resolve, ssh_target  # noqa: E402


def default_key() -> Path | None:
    for name in ("id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"):
        p = Path.home() / ".ssh" / name
        if p.exists():
            return p
    return None


def key_login_ok(host: str) -> tuple[bool, str]:
    p = subprocess.run(SSH + ["-o", "StrictHostKeyChecking=accept-new", ssh_target(host), "hostname"],
                       capture_output=True, text=True, timeout=30)
    if p.returncode == 0:
        return True, p.stdout.strip()
    err = p.stderr.strip().splitlines()
    return False, err[-1] if err else f"ssh exit {p.returncode}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("nodes", nargs="*", help="names or MACs from nodes.txt, or hosts (default: all in nodes.txt)")
    ap.add_argument("--check", action="store_true", help="only report which nodes accept the key")
    ap.add_argument("--key", type=Path, default=None, help="public key to install (default: ~/.ssh/id_ed25519.pub)")
    args = ap.parse_args()

    key = args.key.expanduser() if args.key else default_key()
    if not args.check and (key is None or not key.exists()):
        print("no public key found: create one with `ssh-keygen -t ed25519`, or pass --key", file=sys.stderr)
        return 1

    found = resolve(args.nodes)
    wanted = len(args.nodes) if args.nodes else None
    bad = 0
    for host, name in found:
        ok, info = key_login_ok(host)
        if ok:
            print(f"{name:8s} {host:15s} OK (key login; hostname {info})")
            continue
        if args.check:
            print(f"{name:8s} {host:15s} NO KEY ACCESS ({info})")
            bad += 1
            continue
        print(f"{name:8s} {host:15s} installing {key} (enter the board's 'arduino' password when asked)")
        r = subprocess.run(["ssh-copy-id", "-i", str(key), "-o", "StrictHostKeyChecking=accept-new",
                            ssh_target(host)])
        ok, info = key_login_ok(host) if r.returncode == 0 else (False, "ssh-copy-id failed")
        print(f"{name:8s} {host:15s} {'OK' if ok else 'STILL NO ACCESS'} ({info})")
        bad += 0 if ok else 1
    missing = (wanted if wanted is not None else len(read_all())) - len(found)
    if missing > 0:
        print(f"{missing} node(s) not found on this network (see the discovery lines above)")
    return 1 if bad or missing > 0 else 0


def read_all():
    from fp_nodes import read_nodes
    return read_nodes()


if __name__ == "__main__":
    sys.exit(main())
