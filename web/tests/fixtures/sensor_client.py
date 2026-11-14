"""Acts as a sensor through the sensor library's own HTTP client, for journeys.

usage: python sensor_client.py <server_url> <sensor_key> <sensor_id>   with a JSON list of calls on stdin:
  [{"call": "checkin", "fields": {...}}, {"call": "sounds"}, {"call": "post_events", "events": [...]}]
Prints a JSON list with one reply per call, or {"error": "<KeyRejected|BadRequest|Unavailable>", "detail": ...}.
"""
import json
import sys

from forestpulse_sensor.api import Api, BadRequest, KeyRejected, Unavailable


def main():
    url, key, sensor_id = sys.argv[1:4]
    api = Api(url, key, sensor_id)
    replies = []
    for c in json.load(sys.stdin):
        try:
            if c["call"] == "checkin":
                replies.append(api.checkin(**c.get("fields", {})))
            elif c["call"] == "sounds":
                replies.append(api.sounds())
            elif c["call"] == "post_events":
                replies.append(api.post_events(c["events"]))
            else:
                raise SystemExit(f"unknown call {c['call']}")
        except (KeyRejected, BadRequest, Unavailable) as e:
            replies.append({"error": type(e).__name__, "detail": str(e)})
    json.dump(replies, sys.stdout)


if __name__ == "__main__":
    main()
