"""Serial Bridge brick.

This brick exists to carry brick_compose.yaml, which starts the
`serial-bridge` container with the serial device mapped in. The client code
lives in python/main.py, so nothing needs importing from here.
"""

BRIDGE_HOST = "serial-bridge"
BRIDGE_PORT = 5000
