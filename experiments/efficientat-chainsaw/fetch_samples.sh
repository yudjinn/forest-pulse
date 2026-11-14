#!/usr/bin/env bash
# Downloads ESC-50 test clips: all 40 chainsaw clips plus 6 clips per forest negative class.
# ESC-50: https://github.com/karolpiczak/ESC-50 (CC BY-NC 3.0). Clips are 5 s, 44.1 kHz mono.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p samples/chainsaw samples/negative
BASE=https://raw.githubusercontent.com/karolpiczak/ESC-50/master
[ -f samples/esc50.csv ] || curl -sfL "$BASE/meta/esc50.csv" -o samples/esc50.csv
fetch() { [ -f "$2/$1" ] || curl -sfL "$BASE/audio/$1" -o "$2/$1"; }
export -f fetch; export BASE
awk -F, '$4=="chainsaw"{print $1}' samples/esc50.csv | xargs -P8 -I{} bash -c 'fetch {} samples/chainsaw'
for c in chirping_birds rain wind crackling_fire engine hand_saw; do
  awk -F, -v c="$c" '$4==c{print $1}' samples/esc50.csv | head -6 | xargs -P8 -I{} bash -c 'fetch {} samples/negative'
done
echo "chainsaw: $(ls samples/chainsaw | wc -l)  negative: $(ls samples/negative | wc -l)"
