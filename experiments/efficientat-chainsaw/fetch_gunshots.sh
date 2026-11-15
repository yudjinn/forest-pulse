#!/usr/bin/env bash
# Downloads the gunshot detector's training and test audio into samples/:
#   samples/gunshot/{gunshot,noise}/  forest gunshots and forest background, 3 s clips at 16 kHz, from
#     Vu, Phan, Le & Clink (2024), "Gunshot sound files and spectrogram images from passive acoustic monitoring data
#     in Vietnam", https://zenodo.org/records/13893977 (CC BY 4.0): shotguns and hunting guns recorded in Chu Mom Ray
#     National Park, Vietnam, combined with the Belize set of Katsis et al. (2022) (AudioMoth recorders, 0 to 1,000 m,
#     8 kHz originals). The archive repeats clips across its folders; each clip is kept once.
#   samples/confusers/  ESC-50 bangs and knocks that are not gunshots (fireworks, thunderstorm, door knock, clapping,
#     glass breaking, can opening, footsteps), and the sounds of people indoors that a hall full of them makes
#     (CC BY-NC 3.0, as fetch_samples.sh): every clip of each class.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p samples/gunshot samples/confusers
ZIP=samples/gunshot/clipsforzenodo.zip
[ -f "$ZIP" ] || curl -sfL "https://zenodo.org/api/records/13893977/files/clipsforzenodo.zip/content" -o "$ZIP"
rm -rf samples/gunshot/unpacked samples/gunshot/gunshot samples/gunshot/noise
unzip -q "$ZIP" -x '__MACOSX/*' -d samples/gunshot/unpacked
mkdir -p samples/gunshot/gunshot samples/gunshot/noise
for kind in gunshot noise; do
  (cd samples/gunshot/unpacked && find . -path "*/$kind/*.wav" -exec cp -n {} "../$kind/" \;)
done
rm -rf samples/gunshot/unpacked

BASE=https://raw.githubusercontent.com/karolpiczak/ESC-50/master
[ -f samples/esc50.csv ] || curl -sfL "$BASE/meta/esc50.csv" -o samples/esc50.csv
fetch() { [ -f "$2/$1" ] || curl -sfL "$BASE/audio/$1" -o "$2/$1"; }
export -f fetch; export BASE
for c in fireworks thunderstorm door_wood_knock clapping glass_breaking can_opening footsteps \
  laughing coughing sneezing crying_baby breathing snoring keyboard_typing mouse_click drinking_sipping \
  door_wood_creaks clock_tick clock_alarm pouring_water water_drops brushing_teeth toilet_flush washing_machine \
  church_bells siren car_horn dog cat rooster hen; do
  awk -F, -v c="$c" '$4==c{print $1}' samples/esc50.csv | xargs -P8 -I{} bash -c 'fetch {} samples/confusers'
done
# People talking: LibriSpeech dev-clean (CC BY 4.0, https://www.openslr.org/12), the first 4 utterances of each speaker.
mkdir -p samples/speech
if ! ls samples/speech/*/*.flac >/dev/null 2>&1; then
  [ -f samples/speech/dev-clean.tar.gz ] || curl -sfL https://www.openslr.org/resources/12/dev-clean.tar.gz -o samples/speech/dev-clean.tar.gz
  tar -xzf samples/speech/dev-clean.tar.gz -C samples/speech
  find samples/speech/LibriSpeech -name '*.flac' | sort | awk -F/ '{n[$5]++} n[$5] <= 4' | while read -r f; do
    spk=$(echo "$f" | awk -F/ '{print $5}'); mkdir -p "samples/speech/$spk"; mv "$f" "samples/speech/$spk/"
  done
  rm -rf samples/speech/LibriSpeech samples/speech/dev-clean.tar.gz
fi
echo "gunshot: $(ls samples/gunshot/gunshot | wc -l)  forest noise: $(ls samples/gunshot/noise | wc -l)  confusers: $(ls samples/confusers | wc -l)  speakers: $(ls samples/speech | wc -l)"
