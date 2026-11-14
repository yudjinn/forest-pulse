"""Live mic -> EfficientAT demo. The browser streams 32 kHz mono PCM over a websocket;
the server keeps a sliding window and sends back the top labels a few times a second.

usage: uv run python server.py [--port 8765]   then open http://localhost:8765
"""
import argparse
import asyncio
import glob
import json
import os

import numpy as np
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from classifier import CHAINSAW, MACHINERY, SAMPLE_RATE, Tagger

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = ["mn10_as", "mn04_as", "dymn10_as"]
WINDOW_S = 5.0
HOP_S = 0.5

taggers = {name: Tagger(name) for name in MODELS}
stats = {"connections": 0, "samples_received": 0, "last_rms_dbfs": None, "last_top": None}
app = FastAPI()
app.mount("/samples", StaticFiles(directory=os.path.join(HERE, "samples")), name="samples")


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "index.html"))


@app.get("/api/clips")
def clips():
    cats = {}
    for line in open(os.path.join(HERE, "samples", "esc50.csv")).readlines()[1:]:
        f = line.strip().split(",")
        cats[f[0]] = f[3]
    out = []
    for p in sorted(glob.glob(os.path.join(HERE, "samples", "*", "*.wav"))):
        name = os.path.basename(p)
        out.append({"url": "/samples/" + os.path.relpath(p, os.path.join(HERE, "samples")),
                    "name": name, "category": cats.get(name, "?")})
    return JSONResponse({"clips": out, "models": MODELS})


@app.get("/api/stats")
def get_stats():
    return JSONResponse(stats)


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    stats["connections"] += 1
    win = int(WINDOW_S * SAMPLE_RATE)
    hop = int(HOP_S * SAMPLE_RATE)
    buf = np.zeros(0, np.float32)
    pending = 0
    model = MODELS[0]
    try:
        while True:
            msg = await sock.receive()
            if msg.get("text"):
                model = json.loads(msg["text"]).get("model", model)
                continue
            if msg.get("bytes") is None:
                if msg.get("type") == "websocket.disconnect":
                    break
                continue
            chunk = np.frombuffer(msg["bytes"], np.float32)
            buf = np.concatenate([buf, chunk])[-win:]
            pending += len(chunk)
            stats["samples_received"] += len(chunk)
            if pending < hop or len(buf) < SAMPLE_RATE:
                continue
            pending = 0
            scores = await asyncio.to_thread(taggers[model], buf)
            rms = float(np.sqrt(np.mean(buf[-hop:] ** 2)))
            stats["last_rms_dbfs"] = round(20 * np.log10(rms + 1e-9), 1)
            stats["last_top"] = Tagger.top(scores, 3)
            await sock.send_text(json.dumps({
                "model": model,
                "chainsaw": float(scores[CHAINSAW]),
                "machinery": float(scores[MACHINERY].max()),
                "top": Tagger.top(scores, 6),
                "rms": rms,
            }))
    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
