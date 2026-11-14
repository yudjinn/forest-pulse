# Sounds invariants

- Every served sound's threshold is the one sensitivity in `sound_list.sensitivity`; the per-sound `sounds.threshold` column is still written (teaching sets it) but never served. Read the sensitivity in the same batch as the version (as `soundList` in `api/checkin.ts` does): a version read apart from the thresholds can tell a sensor it holds a list whose thresholds it never fetched.
- A sensitivity change is a sound-list change: it moves `sound_list.version` in the same batch (`setSensitivity`), so the sensors' "has the latest sound list" state and anything counting sensors on the current version treat it like a switch or a taught sound.
