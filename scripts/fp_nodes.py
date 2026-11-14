"""Find the Forest Pulse nodes listed in scripts/nodes.txt on the local network, by their wlan0 MAC.

Shared by deploy-nodes.py, node-logs.py and node-access.py. IPs change between venues; the MAC doesn't:
each MAC is looked up in the laptop's neighbour table (ip neigh on Linux, arp on macOS) and, if any is missing, the local subnet
is pinged once (in parallel, /20 or smaller) so the table learns it.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

NODES_FILE = Path(__file__).resolve().parent / "nodes.txt"
MACOS = sys.platform == "darwin"
SSH = ["ssh", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15"]


def ssh_target(host: str) -> str:
    return host if "@" in host else f"arduino@{host}"


def read_nodes(path: Path = NODES_FILE) -> list[tuple[str, str]]:
    """[(mac, name)] from nodes.txt."""
    out = []
    for line in path.read_text().splitlines():
        parts = line.split("#")[0].split()
        if len(parts) >= 2:
            out.append((parts[0].lower(), parts[1]))
    return out


def norm_mac(mac: str) -> str:
    """macOS arp drops leading zeros (14:b5:cd:f:39:99); pad each octet back to two digits."""
    return ":".join(o.zfill(2) for o in mac.lower().split(":"))


def neighbours() -> dict[str, str]:
    """mac -> IPv4 from the kernel's neighbour table (entries that aren't FAILED / INCOMPLETE)."""
    if MACOS:
        out = subprocess.run(["arp", "-an"], capture_output=True, text=True).stdout
        found = {}
        for line in out.splitlines():  # ? (10.0.32.1) at 40:9e:a4:df:90:80 on en0 ifscope [ethernet]
            f = line.split()
            if len(f) >= 4 and f[2] == "at" and ":" in f[3]:
                found[norm_mac(f[3])] = f[1].strip("()")
        return found
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
    if MACOS:
        route = subprocess.run(["route", "-n", "get", "default"], capture_output=True, text=True).stdout
        devs = [l.split(":", 1)[1].strip() for l in route.splitlines() if l.strip().startswith("interface:")]
        nets = []
        for dev in devs:
            ifc = subprocess.run(["ifconfig", dev], capture_output=True, text=True).stdout
            for line in ifc.splitlines():  # inet 10.0.32.238 netmask 0xfffff000 broadcast ...
                f = line.split()
                if f[:1] == ["inet"] and "netmask" in f:
                    mask = str(ipaddress.IPv4Address(int(f[f.index("netmask") + 1], 16)))
                    nets.append(ipaddress.ip_interface(f"{f[1]}/{mask}").network)
        return nets
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
    wait = ["-t", "1"] if MACOS else ["-W", "1"]  # macOS ping -W is milliseconds; -t is the overall timeout
    hosts = [str(h) for n in nets if n.num_addresses <= 4096 for h in n.hosts()]
    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(lambda h: subprocess.run(["ping", "-c", "1", *wait, h], capture_output=True), hosts))


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
              + ", ".join(n for m, n, _ in targets if m and m not in table) + " ...", file=sys.stderr, flush=True)
        sweep(nets)
        table = neighbours()
    out = []
    for mac, name, host in targets:
        if host:
            out.append((host, name))
        elif mac in table:
            print(f"discovery: {name} ({mac}) is at {table[mac]}", file=sys.stderr, flush=True)
            out.append((table[mac], name))
        else:
            print(f"discovery: {name} ({mac}) NOT FOUND on this network (off, or on another network)", file=sys.stderr, flush=True)
    return out
