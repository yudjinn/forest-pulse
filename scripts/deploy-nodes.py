#!/usr/bin/env python3
"""Update every Uno Q node in parallel: the SoC app (Python + sketch) and the ESP32 (atech) firmware.

    scripts/deploy-nodes.py                    # every node in scripts/nodes.txt, both payloads
    scripts/deploy-nodes.py node2              # by name (or MAC, or a host/IP to skip discovery)
    scripts/deploy-nodes.py --soc-only         # app only (no build, no flash)
    scripts/deploy-nodes.py --mcu-only         # firmware only
    scripts/deploy-nodes.py --sdk              # also reinstall the sensor SDK from upstream main
    scripts/deploy-nodes.py --list             # just find the nodes and print their IPs

Nodes are found by their wlan0 MAC (scripts/nodes.txt), not by IP: the script looks each MAC up in the
laptop's neighbour table and, if any is missing, pings the local subnet once to fill it.

Per node: upload the app -> stop it -> flash the ESP32 through the Uno Q -> start the app (App Lab compiles
and flashes the sketch) -> optionally reinstall the SDK -> wait for "[status] ESP32 OK, server OK".

What it writes on a node (~/ArduinoApps/atech-serial-listener):
- every tracked/untracked-but-not-ignored file of soc/atech-serial-listener, so config.json is the repo's with
  led.rotation_deg set from --rotation (default -90). Other per-board config.json edits are overwritten.
- never forestpulse.toml (the key), forestpulse-state/, data/ or .cache/.

Needs: ssh access as arduino@NODE (key-based), and for the firmware ESP-IDF via mcu/idf-env.sh.
Full per-node logs go to --log-dir (default: a temp dir, printed at the end).
"""
from __future__ import annotations

import argparse
import io
import os
import shlex
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = "soc/atech-serial-listener"
APP_ID = "user:atech-serial-listener"
REMOTE_APP = "~/ArduinoApps/atech-serial-listener"
SECRETS = {"python/forestpulse.toml"}
FW_FILES = ("bootloader/bootloader.bin", "partition_table/partition-table.bin", "acoustic_frontend.bin")
SDK_URL = "forestpulse-sensor @ https://github.com/yudjinn/forest-pulse/archive/refs/heads/main.zip#subdirectory=sensor-sdk"
START_TIMEOUT_S = 45 * 60  # first start on a fresh board: ~0.9 GB image pull over venue Wi-Fi + package installs
NODES_FILE = Path(__file__).resolve().parent / "nodes.txt"
SSH = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15"]


# ---------------------------------------------------------------------------------------------- discovery

def read_nodes(path: Path = NODES_FILE) -> list[tuple[str, str]]:
    """[(mac, name)] from nodes.txt."""
    out = []
    for line in path.read_text().splitlines():
        parts = line.split("#")[0].split()
        if len(parts) >= 2:
            out.append((parts[0].lower(), parts[1]))
    return out


def neighbours() -> dict[str, str]:
    """mac -> IPv4 from the kernel's neighbour table (entries that aren't FAILED / INCOMPLETE)."""
    out = subprocess.run(["ip", "-4", "neigh", "show"], capture_output=True, text=True).stdout
    found = {}
    for line in out.splitlines():
        f = line.split()
        if "lladdr" in f and not ({"FAILED", "INCOMPLETE"} & set(f)):
            found[f[f.index("lladdr") + 1].lower()] = f[0]
    return found


def local_subnets() -> list:
    """IPv4 networks of the laptop's up interfaces with a default route (e.g. wlan0's /20)."""
    import ipaddress
    routes = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True).stdout
    devs = {r.split(" dev ")[1].split()[0] for r in routes.splitlines() if " dev " in r}
    nets = []
    for dev in devs:
        addrs = subprocess.run(["ip", "-4", "-o", "addr", "show", "dev", dev], capture_output=True, text=True).stdout
        for line in addrs.splitlines():
            cidr = line.split(" inet ")[1].split()[0]
            nets.append(ipaddress.ip_interface(cidr).network)
    return nets


def sweep(nets, workers: int = 256) -> None:
    """One ping to every address (in parallel) so the neighbour table learns who is on the subnet."""
    from concurrent.futures import ThreadPoolExecutor
    hosts = [str(h) for n in nets if n.num_addresses <= 4096 for h in n.hosts()]
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda h: subprocess.run(["ping", "-c", "1", "-W", "1", h], capture_output=True), hosts))


def resolve(wanted: list[str]) -> list[tuple[str, str]]:
    """[(host, name)] for the requested nodes (names / MACs from nodes.txt, or plain hosts), finding IPs by MAC."""
    known = read_nodes()
    targets = []  # (mac or None, name, host or None)
    for w in wanted or [name for _, name in known]:
        hit = next(((m, n) for m, n in known if w.lower() in (m, n.lower())), None)
        if hit:
            targets.append((hit[0], hit[1], None))
        elif ":" in w and len(w) == 17:
            targets.append((w.lower(), w.lower(), None))
        else:
            targets.append((None, w, w))  # an explicit host / IP
    table = neighbours()
    if any(mac and mac not in table for mac, _, _ in targets):
        nets = local_subnets()
        print(f"discovery: pinging {', '.join(map(str, nets))} to find "
              + ", ".join(n for m, n, _ in targets if m and m not in table) + " ...", flush=True)
        sweep(nets)
        table = neighbours()
    out = []
    for mac, name, host in targets:
        if host:
            out.append((host, name))
        elif mac in table:
            print(f"discovery: {name} ({mac}) is at {table[mac]}", flush=True)
            out.append((table[mac], name))
        else:
            print(f"discovery: {name} ({mac}) NOT FOUND on this network (off, or on another network)", flush=True)
    return out


# ---------------------------------------------------------------------------------------------- local payloads

def build_firmware(log) -> dict[str, bytes]:
    """idf.py build in mcu/, then the three images and their offsets from flash_args."""
    cmd = "cd mcu && . ./idf-env.sh >/dev/null && idf.py build"
    p = subprocess.run(["bash", "-c", cmd], cwd=ROOT, capture_output=True, text=True)
    log(p.stdout + p.stderr)
    if p.returncode != 0 or "Project build complete" not in p.stdout:
        raise RuntimeError("firmware build failed (see the log)")
    build = ROOT / "mcu" / "build"
    return {name: (build / name).read_bytes() for name in FW_FILES}


def flash_offsets() -> dict[str, str]:
    """image -> offset, from mcu/build/flash_args (e.g. '0x10000 acoustic_frontend.bin')."""
    out = {}
    for line in (ROOT / "mcu" / "build" / "flash_args").read_text().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].startswith("0x"):
            out[parts[1]] = parts[0]
    return out


def app_tar() -> bytes:
    """soc/atech-serial-listener as a tar (paths relative to the app), without the secrets file."""
    files = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", APP_DIR], cwd=ROOT,
                           capture_output=True, text=True, check=True).stdout.split()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for f in files:
            rel = os.path.relpath(f, APP_DIR)
            if rel in SECRETS or not (ROOT / f).is_file():
                continue
            tar.add(ROOT / f, arcname=rel)
    return buf.getvalue()


def fw_tar(images: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for name, data in images.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


# ---------------------------------------------------------------------------------------------- one node

class Node:
    def __init__(self, host: str, log_dir: Path, name: str | None = None):
        self.host = host if "@" in host else f"arduino@{host}"
        self.ip = host.split("@")[-1]
        self.name = f"{name} {self.ip}" if name and name != self.ip else self.ip
        self.step, self.total, self.what = 0, 0, "waiting"
        self.state = "pending"  # pending | running | ok | warn | failed
        self.result = ""
        self.started = time.monotonic()
        self.ended: float | None = None
        self.logfile = log_dir / f"{(name or self.ip)}.log"
        self._log = open(self.logfile, "w")

    def log(self, text: str) -> None:
        self._log.write(text if text.endswith("\n") else text + "\n")
        self._log.flush()

    def ssh(self, script: str, stdin: bytes | None = None, timeout: float = 300) -> str:
        self.log(f"$ ssh {self.host} {script.strip()[:400]}")
        p = subprocess.run(SSH + [self.host, script], input=stdin, capture_output=True, timeout=timeout)
        out = (p.stdout + p.stderr).decode(errors="replace")
        self.log(out)
        if p.returncode != 0:
            raise RuntimeError(f"remote command failed ({p.returncode}): {out.strip().splitlines()[-1:] or ''}")
        return out

    def begin(self, what: str) -> None:
        self.step += 1
        self.what = what
        self.log(f"=== step {self.step}/{self.total}: {what}")


def deploy(node: Node, args, app: bytes | None, fw: bytes | None, offsets: dict[str, str]) -> None:
    steps = ["connect"] + (["upload app"] if app else []) + (["upload firmware"] if fw else []) + ["stop app"]
    steps += (["flash ESP32"] if fw else []) + ["start app"] + (["reinstall SDK"] if args.sdk else []) + ["verify"]
    node.total = len(steps)
    node.state = "running"
    warnings = []
    try:
        node.begin("connect")
        node.ssh("hostname; dpkg -l arduino-app-cli | awk '/^ii/ {print $3}'", timeout=30)

        if app:
            node.begin("upload app")
            rot = shlex.quote(str(args.rotation))
            out = node.ssh(f"set -e; A={REMOTE_APP}; mkdir -p $A && tar -x -C $A && "
                     f"python3 - $A/python/config.json {rot} <<'EOF'\n"
                     "import json, sys\n"
                     "p, rot = sys.argv[1], float(sys.argv[2])\n"
                     "c = json.load(open(p)); c['led']['rotation_deg'] = rot\n"
                     "json.dump(c, open(p, 'w'), indent=2)\n"
                     "EOF\n"
                     f"test -f $A/python/forestpulse.toml || echo 'WARNING: no forestpulse.toml (no server)'",
                     stdin=app, timeout=300)
            if "WARNING: no forestpulse.toml" in out:
                warnings.append("no forestpulse.toml")

        if fw:
            node.begin("upload firmware")
            node.ssh("rm -rf ~/fw-flash && mkdir ~/fw-flash && tar -x -C ~/fw-flash", stdin=fw, timeout=300)

        node.begin("stop app")
        node.ssh(f"arduino-app-cli app stop {APP_ID} >/dev/null 2>&1 || true", timeout=120)

        if fw:
            node.begin("flash ESP32")
            images = " ".join(f"{offsets[n]} /fw/{n}" for n in FW_FILES)
            out = node.ssh(
                "DEV=$(readlink -f /dev/serial/by-id/usb-Espressif_* 2>/dev/null | head -1); "
                "if [ -z \"$DEV\" ]; then echo NO_ESP32; exit 0; fi; "
                "docker run --rm --device=$DEV -v ~/fw-flash:/fw python:3.13-slim sh -c "
                f"\"pip install -q esptool 2>/dev/null && esptool --chip esp32s3 --port $DEV --before usb-reset "
                f"write-flash --flash-mode dio --flash-freq 80m --flash-size 8MB {images}\"", timeout=600)
            if "NO_ESP32" in out:
                warnings.append("no ESP32 attached: not flashed")
            elif out.count("Hash of data verified") != len(FW_FILES):
                raise RuntimeError("flash not verified")

        node.begin("start app (compiles the sketch)")
        # A node's first start downloads App Lab's ~0.9 GB Python base image and installs the packages: allow it.
        node.ssh(f"arduino-app-cli app start {APP_ID} 2>&1 | tail -3", timeout=START_TIMEOUT_S)
        started = node.ssh("docker inspect -f '{{.State.StartedAt}}' atech-serial-listener-main-1", timeout=60).strip()

        if args.sdk:
            node.begin("reinstall SDK")
            node.ssh("docker exec atech-serial-listener-main-1 uv pip install -q --python /app/.cache/.venv/bin/python "
                     f"--reinstall-package forestpulse-sensor {shlex.quote(SDK_URL)} && "
                     f"arduino-app-cli app stop {APP_ID} >/dev/null 2>&1; arduino-app-cli app start {APP_ID} 2>&1 | tail -1",
                     timeout=START_TIMEOUT_S)
            started = node.ssh("docker inspect -f '{{.State.StartedAt}}' atech-serial-listener-main-1",
                               timeout=60).strip()

        node.begin("verify")
        deadline = time.monotonic() + args.verify_timeout
        logs = ""
        while time.monotonic() < deadline:
            logs = node.ssh(f"docker logs --since {shlex.quote(started.splitlines()[-1])} "
                            "atech-serial-listener-main-1 2>&1 | grep -E '\\[status\\]|\\[calib\\] this SDK|Traceback|"
                            "\\[modulino\\]|\\[sdk\\] sensor' | tail -20", timeout=60)
            if "Traceback" in logs or "[status] ESP32 OK, server OK" in logs:
                break
            time.sleep(5)
        sdk = node.ssh(f"grep -h '__version__ =' {REMOTE_APP}/.cache/.venv/lib/python3.*/site-packages/"
                       "forestpulse_sensor/__init__.py 2>/dev/null | cut -d'\"' -f2 || true", timeout=60).strip()
        status = [l for l in logs.splitlines() if "[status]" in l]
        modulino = [l for l in logs.splitlines() if "[modulino]" in l]
        if "Traceback" in logs:
            raise RuntimeError("the app crashed (Traceback in the log)")
        if not status or "ESP32 OK, server OK" not in status[-1]:
            warnings.append(status[-1].split("[status] ")[-1] if status else "no status reported")
        if "[calib] this SDK" in logs:
            warnings.append("SDK has no calibration")
        parts = [f"SDK {sdk or '?'}"]
        if modulino:
            parts.append(modulino[-1].split("[modulino] ")[-1].split(", Qwiic")[0])
        node.result = ", ".join(parts + warnings)
        node.state = "warn" if warnings else "ok"
    except Exception as e:
        node.state = "failed"
        node.result = f"{node.what}: {e}"
        node.log(f"FAILED: {e!r}")
    finally:
        node.ended = time.monotonic()
        node.what = {"ok": "done", "warn": "done (warnings)", "failed": "FAILED"}.get(node.state, node.what)


# ---------------------------------------------------------------------------------------------- progress

COLOR = {"pending": "", "running": "\033[36m", "ok": "\033[32m", "warn": "\033[33m", "failed": "\033[31m"}
SPIN = "|/-\\"


def line(node: Node, tick: int, tty: bool) -> str:
    el = (node.ended or time.monotonic()) - node.started
    bar_w = 12
    filled = int(bar_w * (node.step if node.state != "running" else node.step - 1) / max(node.total, 1))
    bar = "#" * filled + "-" * (bar_w - filled)
    spin = SPIN[tick % 4] if node.state == "running" else " "
    text = f"{node.name:21s} [{bar}] {node.step}/{node.total} {spin} {node.what:32s} {el:5.0f}s"
    if node.result and node.state != "running":
        text += f"  {node.result}"
    return f"{COLOR[node.state]}{text}\033[0m" if tty else text


def watch(nodes: list[Node], threads: list[threading.Thread]) -> None:
    tty = sys.stdout.isatty()
    tick, last = 0, None
    while True:
        alive = any(t.is_alive() for t in threads)
        if tty:
            if tick:
                sys.stdout.write(f"\033[{len(nodes)}F")
            for n in nodes:
                sys.stdout.write("\033[2K" + line(n, tick, True)[: os.get_terminal_size().columns + 12] + "\n")
            sys.stdout.flush()
        else:
            cur = [(n.step, n.what, n.state) for n in nodes]
            if cur != last:
                for n, c in zip(nodes, cur):
                    if last is None or c != last[nodes.index(n)]:
                        print(line(n, tick, False), flush=True)
                last = cur
        if not alive:
            return
        tick += 1
        time.sleep(0.25)


# ---------------------------------------------------------------------------------------------- main

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("nodes", nargs="*", help="node names or MACs from nodes.txt, or hosts (default: all in nodes.txt)")
    ap.add_argument("--list", action="store_true", help="only discover the nodes and print their IPs")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--soc-only", action="store_true", help="only the Uno Q app (Python + sketch)")
    g.add_argument("--mcu-only", action="store_true", help="only the ESP32 firmware")
    ap.add_argument("--no-build", action="store_true", help="flash the existing mcu/build images")
    ap.add_argument("--sdk", action="store_true", help="reinstall the sensor SDK from upstream main")
    ap.add_argument("--rotation", type=float, default=-90.0, help="led.rotation_deg for every node (default -90)")
    ap.add_argument("--verify-timeout", type=float, default=120.0, help="seconds to wait for ESP32 + server OK")
    ap.add_argument("--log-dir", type=Path, default=None)
    args = ap.parse_args()

    found = resolve(args.nodes)
    if args.list:
        return 0 if found and len(found) == len(args.nodes or read_nodes()) else 1
    if not found:
        print("no nodes found")
        return 1
    log_dir = args.log_dir or Path(tempfile.mkdtemp(prefix="fp-deploy-"))
    log_dir.mkdir(parents=True, exist_ok=True)

    app = None if args.mcu_only else app_tar()
    fw, offsets = None, {}
    if not args.soc_only:
        with open(log_dir / "build.log", "w") as blog:
            if args.no_build:
                print("firmware: using the existing mcu/build images", flush=True)
                images = {n: (ROOT / "mcu" / "build" / n).read_bytes() for n in FW_FILES}
            else:
                print("firmware: building (mcu/, idf.py build) ...", flush=True)
                try:
                    images = build_firmware(blog.write)
                except RuntimeError as e:
                    print(f"firmware: {e}; log: {log_dir / 'build.log'}")
                    return 1
        fw, offsets = fw_tar(images), flash_offsets()
        print(f"firmware: {sum(len(v) for v in images.values()) // 1024} KB, offsets "
              + ", ".join(f"{n.split('/')[-1]}@{offsets[n]}" for n in FW_FILES), flush=True)
    if app:
        print(f"app: {len(app) // 1024} KB from {APP_DIR} (forestpulse.toml never sent), rotation {args.rotation:g}",
              flush=True)
    print(flush=True)

    nodes = [Node(h, log_dir, name) for h, name in found]
    threads = [threading.Thread(target=deploy, args=(n, args, app, fw, offsets), daemon=True) for n in nodes]
    for t in threads:
        t.start()
    try:
        watch(nodes, threads)
    except KeyboardInterrupt:
        print("\ninterrupted; remote steps already started keep running")
        return 130
    print(f"\nlogs: {log_dir}")
    return 1 if any(n.state == "failed" for n in nodes) else 0


if __name__ == "__main__":
    sys.exit(main())
