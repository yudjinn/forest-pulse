"""A local stand-in for the server, implementing docs/device-api.md in memory, for integrating before the real one
is deployed. Prints what sensors send.

usage: python -m forestpulse_sensor.devserver [--host 0.0.0.0] [--port 8787] [--key dev-key] [--sounds sounds.json]

Extra endpoints for testing (not part of the API): PUT /dev/sounds replaces the sound list (bumping its version),
GET /dev/events and GET /dev/sensors show what arrived.
"""
import argparse
import json
import threading
import time
from datetime import UTC, datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from importlib import resources

from .api import utc_now_iso


def _parse_time(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=UTC).timestamp()


class State:
    def __init__(self, key: str, sounds: dict):
        self.key = key
        self.lock = threading.Lock()
        self.sounds = sounds
        self.sounds.setdefault("version", 1)
        self.sensors, self.events, self.seen = {}, [], set()

    def set_sounds(self, doc):
        with self.lock:
            doc["version"] = self.sounds["version"] + 1
            self.sounds = doc


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
                    state.sensors[sensor_id] = {**body, "last_checkin": utc_now_iso(), "clock_offset_s": offset}
                    return self._send(200, {"server_time": utc_now_iso(),
                                            "sound_list_version": state.sounds["version"]})
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
