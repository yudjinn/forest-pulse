"""HTTP client for the sensor API (docs/device-api.md). Standard library only."""
import json
import urllib.error
import urllib.request
from datetime import UTC, datetime

from . import __version__

# Cloudflare's edge refuses Python's default user agent (HTTP 403, error 1010) before the service sees the request.
USER_AGENT = f"forestpulse-sensor/{__version__}"


class KeyRejected(Exception):
    """401: the sensor key is wrong. Nothing is discarded; fixing the key flushes the queue."""


class BadRequest(Exception):
    """400: the request as a whole was malformed."""


class Unavailable(Exception):
    """Network down, timeout or server error: retry later."""


def utc_now_iso() -> str:
    return iso(datetime.now(UTC).timestamp())


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ts * 1000) % 1000:03d}Z"


class Api:
    def __init__(self, server_url: str, sensor_key: str, sensor_id: str, timeout: float = 10.0, clock=None):
        """clock: the sensor's wall clock (seconds since the epoch) for sent_at; default the system's."""
        self.base = server_url.rstrip("/") + "/api/v1/sensors/" + urllib.request.quote(sensor_id, safe="")
        self.key = sensor_key
        self.timeout = timeout
        self._now_iso = (lambda: iso(clock())) if clock else utc_now_iso

    def _call(self, method: str, path: str, body: dict | None = None) -> dict:
        data = None if body is None else json.dumps({"sent_at": self._now_iso(), **body}).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.key}", "Content-Type": "application/json", "User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            detail = e.read()[:300].decode(errors="replace")
            if e.code == 401:
                raise KeyRejected(detail) from e
            if e.code == 400:
                raise BadRequest(detail) from e
            raise Unavailable(f"HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as e:
            raise Unavailable(repr(e)) from e

    def checkin(self, **fields) -> dict:
        return self._call("POST", "/checkin", fields)

    def sounds(self) -> dict:
        return self._call("GET", "/sounds")

    def post_events(self, events: list) -> dict:
        return self._call("POST", "/events", {"events": events})

    def post_calibration(self, report: dict) -> dict:
        return self._call("POST", "/calibration", report)
