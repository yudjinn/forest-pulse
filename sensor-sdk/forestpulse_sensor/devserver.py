"""A local stand-in for the server, implementing docs/device-api.md in memory, for integrating before the real one
is deployed. Prints what sensors send.

usage: python -m forestpulse_sensor.devserver [--host 0.0.0.0] [--port 8787] [--key dev-key] [--sounds sounds.json]

Extra endpoints for testing (not part of the API): PUT /dev/sounds replaces the sound list (bumping its version),
GET /dev/events and GET /dev/sensors show what arrived, POST /dev/calibration {"sensors": [ids], "volume": optional
0..1} starts a calibration run with those sensors as roles A, B, C, and GET /dev/calibration shows the latest run with its reports.
POST /dev/warnings {"sensors": [ids]} sends a warning to those sensors, and GET /dev/warnings shows every warning with
when each sensor picked it up and what it confirmed.

Each check-in prints the sensor's trigger health (recordings per minute, trigger values, noise floor), "missing" for
any field the sensor left out.

Calibration as the service runs it, minus the solving: participants get the run in their check-in replies, it is
scheduled 4 s after the last ready confirmation once every participant is ready, and it ends when every participant
has reported.

Warnings as the service sends them: the alarm is on a sensor's check-in replies from its first pickup until it confirms,
for at most 15 s after the warning was sent, and a confirmation is recorded once.
"""
import argparse
import json
import threading
import time
import uuid
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources

from .api import iso, utc_now_iso
from .calibration.patterns import DEFAULT_PATTERNS

ROLES = "ABC"
START_AFTER_READY_S = 4.0
ALARM_PICKUP_S = 15.0


def _parse_time(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC).timestamp()


class State:
    def __init__(self, key: str, sounds: dict):
        self.key = key
        self.lock = threading.Lock()
        self.sounds = sounds
        self.sounds.setdefault("version", 1)
        self.sensors, self.events, self.seen = {}, [], set()
        self.run = None  # the latest calibration run
        self.warnings = {}  # id -> {"sent_at", "sensors": {id: {"delivered_at", "result"}}}, oldest first

    def send_warning(self, sensors):
        with self.lock:
            warning = uuid.uuid4().hex
            self.warnings[warning] = {"sent_at": time.time(),
                                      "sensors": {s: {"delivered_at": None, "result": None} for s in sensors}}
            return {"id": warning}

    def alarm_block(self, sensor_id, body, now):
        """Records the sensor's confirmation, and returns its reply's alarm block (None if none)."""
        done = body.get("alarm_done")
        if isinstance(done, dict):
            target = self.warnings.get(done.get("id"), {}).get("sensors", {}).get(sensor_id)
            if target is not None and target["result"] is None and done.get("result") in ("played", "failed"):
                target["result"] = done["result"]
        for warning, w in self.warnings.items():
            target = w["sensors"].get(sensor_id)
            if target is not None and target["result"] is None and now - w["sent_at"] < ALARM_PICKUP_S:
                if target["delivered_at"] is None:
                    target["delivered_at"] = now
                return {"id": warning}
        return None

    def start_run(self, sensors, volume=None):
        with self.lock:
            roles = dict(zip(sensors, ROLES))
            self.run = {"run_id": uuid.uuid4().hex, "roles": roles, "ready": {}, "start_at": None, "reports": {},
                        "ended": False, "volume": volume}
            return self.run

    def calibration_block(self, sensor_id, body, now):
        """Records a participant's ready confirmation and returns its reply's calibration block (None if none)."""
        run = self.run
        if not run or run["ended"] or sensor_id not in run["roles"]:
            return None
        if body.get("calibration_ack") == run["run_id"] and sensor_id not in run["ready"]:
            run["ready"][sensor_id] = now
            if len(run["ready"]) == len(run["roles"]):
                run["start_at"] = max(run["ready"].values()) + START_AFTER_READY_S
        order = list(run["roles"].values())
        block = {"run_id": run["run_id"], "role": run["roles"][sensor_id], "order": order,
                 "patterns": {r: dict(zip(("f_start_hz", "f_mid_hz", "f_end_hz", "duration_ms"),
                                          DEFAULT_PATTERNS[r].emit_args())) for r in order},
                 "slot_ms": 500, "round_gap_ms": 1000, "rounds": 4}
        if run["start_at"] is not None:
            block["start_at"] = iso(run["start_at"])
        if run.get("volume") is not None:
            block["volume"] = run["volume"]
        return block

    def set_sounds(self, doc):
        with self.lock:
            doc["version"] = self.sounds["version"] + 1
            self.sounds = doc


def checkin_line(sensor_id, body):
    """The trigger health a check-in carried, each field "missing" when the sensor left it out."""
    per_min, trigger, floor = body.get("recordings_per_min"), body.get("trigger"), body.get("noise_floor_dbfs")
    per_min = f"{per_min} recordings/min" if per_min is not None else "recordings/min missing"
    trigger = " ".join(f"{k} {v}" for k, v in trigger.items()) if isinstance(trigger, dict) and trigger else "missing"
    floor = f"{floor} dBFS" if floor is not None else "missing"
    return f"{sensor_id}: check-in, {per_min}, trigger {trigger}, noise floor {floor}"


def make_handler(state: State, quiet: bool):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _body(self):
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}")

        def _route(self, method):
            parts = self.path.strip("/").split("/")
            if parts[0] == "dev":
                return self._dev(method, parts[1:])
            if parts[:3] != ["api", "v1", "sensors"] or len(parts) != 5:
                return self._send(404, {"error": "not found"})
            if self.headers.get("Authorization") != f"Bearer {state.key}":
                return self._send(401, {"error": "sensor key rejected"})
            sensor_id, action = parts[3], parts[4]
            try:
                body = self._body() if method == "POST" else {}
            except json.JSONDecodeError:
                return self._send(400, {"error": "body is not JSON"})
            offset = time.time() - _parse_time(body["sent_at"]) if "sent_at" in body else 0.0
            with state.lock:
                if method == "POST" and action == "checkin":
                    if not quiet:  # before storing it, so whoever sees the check-in stored can read its line
                        print(checkin_line(sensor_id, body), flush=True)
                    state.sensors[sensor_id] = {**body, "last_checkin": utc_now_iso(), "clock_offset_s": offset}
                    reply = {"server_time": utc_now_iso(), "sound_list_version": state.sounds["version"]}
                    block = state.calibration_block(sensor_id, body, time.time())
                    if block:
                        reply["calibration"] = block
                    if not quiet and isinstance(body.get("alarm_done"), dict):
                        print(f"{sensor_id}: alarm {body['alarm_done'].get('id')} "
                              f"{body['alarm_done'].get('result')}", flush=True)
                    alarm = state.alarm_block(sensor_id, body, time.time())
                    if alarm:
                        reply["alarm"] = alarm
                    return self._send(200, reply)
                if method == "POST" and action == "calibration":
                    run = state.run
                    if not run or run["run_id"] != body.get("run_id") or sensor_id not in run["roles"]:
                        return self._send(404, {"error": "no such calibration run for this sensor"})
                    if run["ended"]:
                        return self._send(409, {"error": "the run has ended"})
                    run["reports"][sensor_id] = body
                    run["ended"] = len(run["reports"]) == len(run["roles"])
                    if not quiet:
                        print(f"{sensor_id}: calibration report {', '.join(body.get('errors') or []) or 'ok'}",
                              flush=True)
                    return self._send(200, {"accepted": True})
                if method == "GET" and action == "sounds":
                    return self._send(200, state.sounds)
                if method == "POST" and action == "events":
                    if not isinstance(body.get("events"), list):
                        return self._send(400, {"error": "events must be a list"})
                    known = {s["id"] for s in state.sounds["sounds"]}
                    results = []
                    for e in body["events"]:
                        eid = e.get("event_id")
                        if not eid or "sound_id" not in e or "detected_at" not in e:
                            results.append({"event_id": eid, "status": "rejected", "reason": "missing fields"})
                        elif (sensor_id, eid) in state.seen:
                            results.append({"event_id": eid, "status": "duplicate"})
                        elif e["sound_id"] not in known:
                            state.seen.add((sensor_id, eid))
                            results.append({"event_id": eid, "status": "dropped"})
                        else:
                            state.seen.add((sensor_id, eid))
                            corrected = datetime.fromtimestamp(_parse_time(e["detected_at"]) + offset, UTC)
                            state.events.append({**e, "sensor_id": sensor_id, "corrected_at": corrected.isoformat()})
                            results.append({"event_id": eid, "status": "accepted"})
                            if not quiet:
                                angle = f" angle {e['angle_deg']:.0f}" if "angle_deg" in e else ""
                                print(f"{corrected:%H:%M:%S} {sensor_id}: {e['sound_id']} "
                                      f"{e.get('confidence', 0):.2f}{angle}", flush=True)
                    return self._send(200, {"results": results, "sound_list_version": state.sounds["version"]})
            return self._send(404, {"error": "not found"})

        def _dev(self, method, parts):
            if method == "PUT" and parts == ["sounds"]:
                state.set_sounds(self._body())
                return self._send(200, {"version": state.sounds["version"]})
            if method == "GET" and parts == ["events"]:
                with state.lock:
                    return self._send(200, state.events)
            if method == "GET" and parts == ["sensors"]:
                with state.lock:
                    return self._send(200, state.sensors)
            if method == "POST" and parts == ["calibration"]:
                body = self._body()
                return self._send(200, state.start_run(body["sensors"], body.get("volume")))
            if method == "GET" and parts == ["calibration"]:
                with state.lock:
                    return self._send(200, state.run)
            if method == "POST" and parts == ["warnings"]:
                return self._send(200, state.send_warning(self._body()["sensors"]))
            if method == "GET" and parts == ["warnings"]:
                with state.lock:
                    return self._send(200, state.warnings)
            return self._send(404, {"error": "not found"})

        def do_GET(self):
            self._route("GET")

        def do_POST(self):
            self._route("POST")

        def do_PUT(self):
            self._route("PUT")

    return Handler


def serve(port: int = 8787, key: str = "dev-key", sounds: dict | None = None, quiet: bool = False, host: str = "127.0.0.1"):
    """Starts the server in a background thread and returns (server, state)."""
    if sounds is None:
        sounds = json.loads(resources.files(__package__).joinpath("data/seed_sounds.json").read_text())
    state = State(key, sounds)
    server = ThreadingHTTPServer((host, port), make_handler(state, quiet))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to accept sensors on the local network")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--key", default="dev-key")
    ap.add_argument("--sounds", help="sound list JSON (default: the built-in seed list)")
    args = ap.parse_args()
    sounds = None
    if args.sounds:
        with open(args.sounds) as f:
            sounds = json.load(f)
    server, _ = serve(args.port, args.key, sounds, host=args.host)
    print(f"dev server on http://{args.host}:{args.port}  (sensor key: {args.key})", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        server.shutdown()


if __name__ == "__main__":
    main()
