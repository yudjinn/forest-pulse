#!/usr/bin/env python3
"""Follow the Uno Q app (SoC) logs of every node at once, one prefixed, coloured line per log line.

    scripts/node-logs.py                       # all nodes in scripts/nodes.txt, last 20 lines each, then follow
    scripts/node-logs.py node2                 # one node (name, MAC, or a host/IP)
    scripts/node-logs.py -n 200 --no-follow    # last 200 lines of each, then exit
    scripts/node-logs.py --since 10m           # everything from the last 10 minutes, then follow
    scripts/node-logs.py -g 'heard|\\[calib\\]|\\[status\\]|Traceback'    # only matching lines (Python regex)
    scripts/node-logs.py --quiet               # hide the noisy per-second '[atech] pre/live ... peak dBFS' lines

Reads `docker logs` of the app container (atech-serial-listener-main-1) over SSH; the app's own lines carry
prefixes like [status], [sdk], [calib], [trigger], [modulino], [atech]. When the app restarts (deploy, App Lab)
the container is recreated: the follower notices and reconnects. Nodes are found by MAC (fp_nodes.py).
Needs key-based SSH to arduino@<node> (scripts/node-access.py sets that up). Ctrl-C to stop.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fp_nodes import SSH, resolve, ssh_target  # noqa: E402

CONTAINER = "atech-serial-listener-main-1"
COLORS = ["\033[36m", "\033[35m", "\033[33m", "\033[32m", "\033[34m", "\033[31m"]
NOISE = re.compile(r"\[atech\] (pre |live) t=|\[atech\] INFO ")
_print_lock = threading.Lock()


def emit(prefix: str, text: str) -> None:
    with _print_lock:
        sys.stdout.write(f"{prefix} {text}\n")
        sys.stdout.flush()


def follow(host: str, name: str, color: str, args, pattern) -> None:
    tty = sys.stdout.isatty()
    prefix = f"{color}{name:>6}\033[0m |" if tty else f"{name:>6} |"
    since = f"--since {args.since}" if args.since else f"--tail {args.lines}"
    first = True
    while True:
        cmd = (f"docker logs {'-f ' if args.follow else ''}{since if first else '--since 1s'} {CONTAINER} 2>&1 || "
               "echo '__NO_CONTAINER__'")
        proc = subprocess.Popen(SSH + [ssh_target(host), cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                text=True, errors="replace", bufsize=1)
        missing = False
        for raw in proc.stdout:
            line = raw.rstrip("\n")
            if line == "__NO_CONTAINER__":
                missing = True
                continue
            if args.quiet and NOISE.search(line):
                continue
            if pattern and not pattern.search(line):
                continue
            emit(prefix, line)
        proc.wait()
        if not args.follow:
            return
        first = False
        # the container ended (app restart / deploy) or the connection dropped: wait and reconnect
        emit(prefix, "--- app not running; waiting for it ---" if missing else
             f"--- log stream ended (exit {proc.returncode}); reconnecting ---")
        time.sleep(5)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("nodes", nargs="*", help="names or MACs from nodes.txt, or hosts (default: all in nodes.txt)")
    ap.add_argument("-n", "--lines", type=int, default=20, help="lines of history per node (default 20)")
    ap.add_argument("--since", help="history from this long ago instead of -n (docker syntax: 10m, 1h, a timestamp)")
    ap.add_argument("--no-follow", dest="follow", action="store_false", help="print the history and exit")
    ap.add_argument("-g", "--grep", help="only lines matching this Python regex")
    ap.add_argument("-q", "--quiet", action="store_true", help="hide per-second peak lines and INFO dumps")
    args = ap.parse_args()

    found = resolve(args.nodes)
    if not found:
        print("no nodes found", file=sys.stderr)
        return 1
    pattern = re.compile(args.grep) if args.grep else None
    threads = [threading.Thread(target=follow, args=(h, n, COLORS[i % len(COLORS)], args, pattern), daemon=True)
               for i, (h, n) in enumerate(found)]
    for t in threads:
        t.start()
    try:
        while any(t.is_alive() for t in threads):
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
