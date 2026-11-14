#!/usr/bin/env bash
# Synthetic crowd babble: 10 macOS voices talking over each other, 60 s, 32 kHz mono -> samples/babble.wav.
# A stand-in for a hackathon room until we record the real one.
set -euo pipefail
cd "$(dirname "$0")"
T=$(mktemp -d)
TEXT="So we wired the microphones to the board this morning and the latency looks fine. \
Did anyone grab coffee yet? The judges are coming around at four, we still need slides. \
I think the model is too big for the device but let's measure it first. \
Honestly the wifi here is terrible, can you hotspot from your phone? \
We could deploy it on the edge and only send alerts, that saves a lot of data. "
i=0
for v in Albert Aman Daniel "Eddy (English (UK))" "Flo (English (US))" Fred "Grandma (English (UK))" "Grandpa (English (US))" Samantha Karen; do
  say -v "$v" -r $((170 + i * 7)) -o "$T/v$i.aiff" "$TEXT $TEXT $TEXT" 2>/dev/null || continue
  ffmpeg -loglevel error -y -i "$T/v$i.aiff" -af "adelay=$((i * 1300))|$((i * 1300)),apad,atrim=0:60" -ar 32000 -ac 1 "$T/v$i.wav"
  i=$((i + 1))
done
ffmpeg -loglevel error -y $(for f in "$T"/v*.wav; do echo -i "$f"; done) \
  -filter_complex "amix=inputs=$i:normalize=0,volume=0.5,atrim=10:60" -ar 32000 -ac 1 samples/babble.wav
rm -rf "$T"
echo "babble from $i voices -> samples/babble.wav"
