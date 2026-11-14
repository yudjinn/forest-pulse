# Working with the sensor nodes (Uno Q + atech board)

How an agent reaches, watches and updates the physical Forest Pulse nodes from this laptop. All scripts are in `scripts/`. Run them from the repo root; they need only Python 3 and `ssh`.

## The nodes
- **Hardware:** each node is an Arduino Uno Q with:
  - the atech board (an ESP32-S3 and the mics) on USB;
  - a Modulino Thermo and Buzzer on its Qwiic connector.
- **`scripts/nodes.txt`:** lists every node by its **wlan0 MAC** and a short name (`node1`, `node2`).
  - IPs change between venues and DHCP leases; the MAC doesn't.
  - To add a board, add a line. Its MAC is in `cat /sys/class/net/wlan0/address` on the board, and its sensor ID is `fp-<MAC without colons>`.
- **Discovery (`scripts/fp_nodes.py`):** finds each node's IP from the laptop's neighbour table (`ip neigh`). If a MAC is missing, it pings the local subnet once (up to /20, about 25 s) and looks again. A node that's off or on another network is reported as not found and skipped.
- **Addressing nodes in every script:** a name (`node2`), a MAC, or a raw host/IP (skips discovery). With no argument, a script acts on every node in `nodes.txt`. `scripts/deploy-nodes.py --list` just prints where they are.

## 1. Access: `scripts/node-access.py`
Every other script logs in as `arduino@<node>` with an SSH key and never types a password.
- **As an agent, run only `scripts/node-access.py --check`.** It's non-interactive: it reports `OK` or `NO KEY ACCESS` per node and changes nothing.
- **If any node shows `NO KEY ACCESS`:**
  - ask the user to run `! scripts/node-access.py` in the Claude Code prompt;
  - it runs `ssh-copy-id`, and the board asks for its `arduino` password once;
  - **never ask the user to type the password into the chat.**
- **Brand-new board not on Wi-Fi yet:** it isn't on the network, so discovery can't find it.
  - Reach it over USB-C with ADB. `adb` isn't on PATH; it's at `~/Android/Sdk/platform-tools/adb`, or App Lab's copy at `~/.arduino15/packages/arduino/tools/adb/32.0.0/adb`.
  - `adb shell` gives a shell as `arduino`.
  - First-time setup (Wi-Fi, password, system update) is done with Arduino App Lab, or by the user with sudo. sudo needs the user's password.

## 2. Logs: `scripts/node-logs.py`
Follows every node's app log at once, one line per log line, prefixed and coloured by node name. It reconnects by itself when the app restarts.

```sh
scripts/node-logs.py                                # all nodes: last 20 lines, then follow (Ctrl-C to stop)
scripts/node-logs.py node2 -q                       # one node, without the per-second peak / INFO noise
scripts/node-logs.py --since 30m --no-follow -g '\[status\]|\[calib\]|heard|Traceback'   # a filtered snapshot
```

As an agent, always pass `--no-follow`, which gives a snapshot and exits, or wrap the call in `timeout`. Following never exits by itself.

**Log prefixes:**

| Prefix | Meaning |
|---|---|
| `[status]` | ESP32 connected / server reachable; also drives the status LED |
| `[sdk]` | sensor SDK: `heard <sound>`, sound list, server errors |
| `[atech]` | ESP32 stream: `=== event start/end`, per-second `peak dBFS`, `INFO` (polled, logged once a minute) |
| `[event]` | a finished recording, with its direction |
| `[calib]` | location calibration hooks, and test modes |
| `[trigger]` | ESP32 trigger thresholds and the D7 pin |
| `[modulino]` | thermo / buzzer presence and the Qwiic bus |
| `[climate]` | temperature → speed of sound |
| `[led]`, `[matrix]` | LED matrix |

## 3. Deploy: `scripts/deploy-nodes.py`
Updates all nodes in parallel and shows one progress line per node.
- **Steps:** upload the app → stop it → flash the ESP32 through the Uno Q → start the app (App Lab compiles and flashes the sketch) → verify from the log (`ESP32 OK, server OK`).
- **Options:**
  - `--soc-only`: app only;
  - `--mcu-only`: firmware only;
  - `--no-build`: flash the existing `mcu/build`;
  - `--sdk`: reinstall the sensor SDK from upstream main. Needed after an SDK update, because App Lab doesn't reinstall packages when `requirements.txt` changes.
- **Logs:** per-node logs go to the printed `logs:` directory.
- **Timing:** about 1.5 min per node; the steps run in parallel.
  - A fresh board's first app start takes 10–15 min, because it downloads App Lab's ~0.9 GB Python image over Wi-Fi.
  - The script allows 45 min for that step.
- **What it writes:** the repo's `soc/atech-serial-listener` files, with `led.rotation_deg` set by `--rotation` (default −90). That overwrites the board's `config.json`.

## Per-board files (never sent or overwritten by the scripts)
In `~/ArduinoApps/atech-serial-listener/python/` on each board:
- **`forestpulse.toml`:** server URL, sensor key and sensor ID.
  - It's secret: mode 600, git-ignored.
  - Don't print the key.
  - All nodes share one key; the sensor ID tells them apart.
- **`config.local.json`:** per-board overrides merged over `config.json`. Currently:
  - node2: the calibration test modes (a faked bearing, mic2 only) and `trigger.coherence: 0`, because only its mic2 is fitted;
  - node1: the same calibration test modes with mic1. Its three mics time the other board's beep up to 25 samples apart (reflections in the hall, and the beep's 2.5 to 5 kHz band is too high for this array's spacing to give a bearing), so its detections come out weak and the run fails. With one mic it ranges reliably; the facings are faked.
  - `calibration.test_dump_calibration: true` saves each calibration stream's raw 3-mic audio to `data/calibration/` on the board (an `.npz` with the SDK's stream positions per block), to replay a run's detections offline. Off by default; turn it off again afterwards.

  The app logs `[app] board overrides from config.local.json` when one exists.

## Things that bite
- **sudo** on a board needs the user's password. System updates (`apt`, `hostnamectl`) are the user's job.
- **Venue Wi-Fi drops:** SDK lines like `server unavailable … name resolution` are usually the venue's network, not the code. The SDK queues events and retries.
- **Shared hardware:** both nodes run the same app. Don't stop a node's app, reflash it, or change its config while the user is demoing or testing on it, unless asked.
