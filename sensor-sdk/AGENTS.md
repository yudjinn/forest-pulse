# Sensor library invariants

- Every request to the sensor API sends the library's own `User-Agent` (`forestpulse-sensor/<version>`, set in `api.py`). The live site's Cloudflare zone refuses Python's default `Python-urllib/*` agent with HTTP 403 (error code 1010) before the Worker runs; the library reads that as "server unavailable" and retries forever, so a board without the header never delivers. Local journeys cannot catch this: only the live edge applies the check.
