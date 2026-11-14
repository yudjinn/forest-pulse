# Demo kit

What the presenter plays on stage. The player page (`/dashboard/player/`, behind the dashboard sign-in) loops one
sample at a time through the phone's audio, so a paired Bluetooth speaker plays it to the sensors.

## Player samples

Committed in `web/bucket/player/` with their credits in `samples.json`; the deploy uploads that folder to the private
bucket and the journey harness mirrors it into local storage. Each sample is at most 30 s, cut at quiet moments and
crossfaded so it loops without a seam, and matched to the same RMS level (-20 dBFS, peaks limited).

| Sample | Recordist | Source | Licence |
|---|---|---|---|
| Chainsaw 1 | | [ESC-50, Freesound 116765](https://freesound.org/s/116765/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
| Chainsaw 2 | | [ESC-50, Freesound 64398](https://freesound.org/s/64398/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
| Chainsaw 3 | | [ESC-50, Freesound 169127](https://freesound.org/s/169127/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
| Boreal owl 1 | Johan Lundgren | [xeno-canto XC1145038](https://xeno-canto.org/1145038) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| Boreal owl 2 | Stein Ø. Nilsen | [xeno-canto XC217840](https://xeno-canto.org/217840) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| Tawny owl | Mark Plummer | [xeno-canto XC1080086](https://xeno-canto.org/1080086) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

The samples are honest:

- The seeded chainsaw detector (the service's seeded sound list and the sensor library's built-in list) never trained
  on any clip cut from these three ESC-50 source recordings.
- The owls are the experiment's held-out recordings, whose recordists have no other recording in its set. The
  teaching pack must use boreal owl recordings by other recordists, and the other-sounds library leaves out every
  held-out owl recording (`experiments/efficientat-chainsaw/heads/owl_holdout.json`), these included.

## Rebuilding

From the repository root, after `experiments/efficientat-chainsaw/setup.sh` has fetched the recordings (the owls need
`XC_KEY`). No other network is needed.

```
uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py prepare
(cd experiments/efficientat-chainsaw && uv run python train_heads.py chainsaw)
uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py check
uv run --project experiments/efficientat-chainsaw python demo-kit/player_samples.py seed --version <n> \
    --migration web/migrations/<UTC stamp>_<what>.sql
```

`prepare` writes the samples and `samples.json`. `train_heads.py chainsaw` retrains the chainsaw detector without the
player's source recordings and records the ones it trained on. `check` fails if any chainsaw sample shares a source
recording with them. `seed` copies the detector into the sensor library's built-in list at list version `<n>` (the
version the service reaches after the new migration) and writes that migration. Bump the sensor library's version
with it.
