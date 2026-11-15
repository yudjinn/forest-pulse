# Demo kit

What the presenter plays on stage. The dashboard's player (the speaker button at the top right) loops one
sample at a time through the phone's audio, so a paired Bluetooth speaker plays it to the sensors.

## Player samples

Committed in `web/bucket/player/` with their credits in `samples.json`; the deploy uploads that folder to the private
bucket and the journey harness mirrors it into local storage. Each sample is at most 30 s, cut at quiet moments and
crossfaded so it loops without a seam, and matched to the same RMS level (-20 dBFS, peaks limited).

| Sample | Recordist | Source | Licence |
|---|---|---|---|
| Chainsaw 1 | UncleSigmund | [ESC-50, Freesound 116765](https://freesound.org/s/116765/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
| Chainsaw 2 | Benboncan | [ESC-50, Freesound 64398](https://freesound.org/s/64398/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
| Chainsaw 3 | fkurz | [ESC-50, Freesound 169127](https://freesound.org/s/169127/) | [CC BY-NC 3.0](https://creativecommons.org/licenses/by-nc/3.0/) |
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

## Teaching pack

The boreal owl recordings the presenter drops into "Teach a new sound" on stage. They are not in the repository:
`teaching_pack.py` builds them on the presenting laptop into the folder `~/Desktop/Boreal owl teaching pack`
(or `$FP_TEACHING_PACK`). The folder holds only the clips, so on stage select everything in it and drop it on the
page. Its report and credits are committed in `teaching_pack.json`.

The pack is whichever of 10, 15 or 20 recordings works on the player's own samples with the widest margin. A size
works when teaching it (summaries with the sensor library's model, the teach request's own training against the
stored other-sounds library) makes the sensor library's replay report both player boreal owls and never the tawny
owl; of the sizes that work, the one whose lowest score on the two boreal owls is highest is kept. Candidates are the experiment's boreal
owls minus the player's recordists, the held-out recordings and no-derivatives licences, one recording per recordist
first, songs before calls, longer before shorter; each clip is the recording's first 60 s.

The page mixes each recording over the hall at random, so every size is taught with five different mixes and works
only if it works with all five. Scores are the detector's top confidence on each player sample (threshold 0.5).

| Size | Boreal owl 1 | Boreal owl 2 | Tawny owl | Chainsaws | Result |
|---|---|---|---|---|---|
| 10 | heard in 5 of 5 (1.00) | heard in 5 of 5 (0.56 to 0.89) | not heard | not heard | works, lowest 0.56 |
| 15 | heard in 5 of 5 (1.00) | heard in 5 of 5 (0.82 to 0.97) | not heard | not heard | works, lowest 0.82, chosen |
| 20 | heard in 5 of 5 (1.00) | heard in 5 of 5 (0.94 to 0.99) | heard in 3 of 5 (0.59 to 0.65) | not heard | fails |

| Clip | Recordist | Source | Licence |
|---|---|---|---|
| boreal-owl-XC1097665.wav | Dag Österlund | [xeno-canto XC1097665](https://xeno-canto.org/1097665) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC560096.wav | Patrik Åberg | [xeno-canto XC560096](https://xeno-canto.org/560096) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC625748.wav | Anders Westman | [xeno-canto XC625748](https://xeno-canto.org/625748) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC632037.wav | Stanislas Wroza | [xeno-canto XC632037](https://xeno-canto.org/632037) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC762214.wav | Romuald Mikusek | [xeno-canto XC762214](https://xeno-canto.org/762214) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC801369.wav | Rafał Kurowski | [xeno-canto XC801369](https://xeno-canto.org/801369) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC985318.wav | Bill Pyle | [xeno-canto XC985318](https://xeno-canto.org/985318) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC312639.wav | Jens Kirkeby | [xeno-canto XC312639](https://xeno-canto.org/312639) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC356978.wav | Antero Lindholm | [xeno-canto XC356978](https://xeno-canto.org/356978) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC782854.wav | Teet Sirotkin | [xeno-canto XC782854](https://xeno-canto.org/782854) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC307650.wav | PE Svahn | [xeno-canto XC307650](https://xeno-canto.org/307650) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC638436.wav | Sergiusz Nizinski | [xeno-canto XC638436](https://xeno-canto.org/638436) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC325180.wav | Jarek Matusiak | [xeno-canto XC325180](https://xeno-canto.org/325180) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC343176.wav | Tero Linjama | [xeno-canto XC343176](https://xeno-canto.org/343176) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| boreal-owl-XC234260.wav | Mats Svensson Pavval | [xeno-canto XC234260](https://xeno-canto.org/234260) | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

Rebuild from the repository root, after `experiments/efficientat-chainsaw/setup.sh` has fetched the recordings (with
`XC_KEY`); the script itself needs no network and takes about three minutes:

```
uv run --project experiments/efficientat-chainsaw python demo-kit/teaching_pack.py
```

If no size works it prints which player samples were missed or falsely heard, writes the report and makes no pack.
The script never deletes or overwrites a file: it adds the new clips, leaves identical ones as they are, and refuses a
folder that holds anything else, so a pack that changes to fewer or other clips needs the old ones removed by hand.

## Rehearsal

The rehearsal journey (`web/tests/e2e/rehearsal.spec.ts`) runs the whole demo script below as named steps and prints
each step's result; a step that fails names itself and what it expected. It teaches the pack through the real teach
dialog under a fresh name (never "Boreal owl"), uses its own sensors placed clear of every other sensor on the plan, and
ends by deleting what it taught, removing its sensors and clearing events, then checks that the sound list and every
other sensor are as they were. It fails if the pack folder is not the reported pack. Without the pack it is skipped,
unless `FP_REQUIRE_TEACHING_PACK=1` is set, when it fails; set it wherever the run is meant as proof.

Against the live site, from `web/` after `npm run deploy` (the live password and sensor key come from
`.dev-secrets.local`; the live run always requires the pack):

```
FP_E2E_PORT_BASE=8800 FP_REHEARSAL_ORIGIN=https://forestpulse.paxid.com npx playwright test tests/e2e/rehearsal.spec.ts
```

Clearing events removes every event on the live site, the real boards' included, and the run clears as soon as it has
printed what it clears from other sensors (count and time span per sensor). If the team needs the real boards' events,
save them from the event log before starting the run. It also fails at its start if any taught sound is listed (one
left by an interrupted rehearsal, or "Boreal owl" itself): delete it from the dashboard's sound list and run it again.

### Calibration rehearsal

The calibration rehearsal (`web/tests/e2e/rehearsal-calibration.spec.ts`) runs only against the live site. Three
simulated boards check in under rehearsal names, the run is started with Calibrate, and it must end "Calibrated" with
the triangle the boards stand in; the rehearsal then switches its boards off, removes them, and checks that every
other sensor is where it was and the plan is not left calibrated. Each step prints its result, and a failed step names
itself and what it expected. From `web/` after `npm run deploy`, about a minute:

```
FP_E2E_PORT_BASE=8800 FP_REHEARSAL_ORIGIN=https://forestpulse.paxid.com npx playwright test tests/e2e/rehearsal-calibration.spec.ts
```

A run takes the first three boards on the plan that can calibrate and replaces the plan's measured layout, so the
rehearsal refuses to start while a real board that can calibrate is online, or while the plan shows "Calibrated": run
it before switching the boards on and before calibrating on stage. If an earlier calibration left the plan
calibrated, typing any board's Facing makes it manual again; the stage calibration sets it afterwards. Its boards
send no sound events, so it never clears events.

## Presenter checklist

Before the audience arrives:

1. Deploy (`npm run deploy` in `web/`) and run both live rehearsals above, the calibration one first, before the
   boards are on; every step passes.
2. Boards on, each running the sensor library 0.6.2 or later (`scripts/deploy-nodes.py --sdk`; earlier versions can
   lose their check-ins for good after one cut-short reply on busy Wi-Fi), and Online on the plan. Each board's log
   shows `[modulino] buzzer OK`, or it can neither calibrate nor play a warning. A board with fewer than 3 mics fitted
   has `"bearing": {"detections": false}` in its `config.local.json` (`docs/agents/nodes.md`), or its direction lines
   point anywhere. Boards and the laptop share a network of their own (a router or phone hotspot), not the
   audience's Wi-Fi: two boards' reports of one sound must arrive within 3 s of each other to give a location.
3. Stage check: record the buzzer at 1 m, 3 m and 5 m on the stage and run the stage check tool on the three
   recordings (`sensor-sdk/README.md`, Stage check). FAIL: skip to step 6.
4. Calibrate: with 2 or 3 boards standing where they will be, open Devices, press Calibrate and wait for
   "Calibrated" and the time. A failure names the board or pair: fix it and press again, or go to step 6.
5. Tape measure: measure between each pair of boards and compare with the distance shown on the map (with Devices
   open), then play Chainsaw 1 between two boards and check that the map shows it where it was. Off by much more than 15 cm, or the
   wrong place: go to step 6.
6. Fallback, only if a step above failed: with Devices open, drag each board on the map to where it stands in the
   hall and set its Facing; with only one board working it shows direction only. Do this before any sound is played: an edit only
   affects events that arrive after it.
7. The sound list has no "Boreal owl", and the event log (the second tab under Devices) is empty (Clear events
   if not).
8. The phone: signed in on the dashboard with the player open (the speaker button), paired with the Bluetooth
   speaker, volume up, screen lock off.
9. The laptop: signed in on the dashboard, the "Boreal owl teaching pack" folder open on the Desktop. Open "Teach a
   new sound" once, drop a clip and wait until it shows Ready, then Cancel: the dialog loads about 35 MB of model
   the first time, which should come from the browser's cache on stage.
10. After any deploy, reload every open dashboard tab, the phone's included: a tab keeps the code it loaded.

On stage:

1. Play Chainsaw 1 from the phone near one board: a Logging activity appears with the direction line from that board.
2. Play it again between two boards: the plan shows where it was, and the activity shows the distance from each board.
3. Stop the player, then press Send warning on the Logging activity: the boards that heard it sound the alarm and
   the activity lists each one's outcome. Send it now: it is offered only for 5 minutes after the last chainsaw.
4. Under the sound list, choose "Teach a new sound", name it "Boreal owl", leave Wildlife, select everything in the pack
   folder and drop it on the page, wait for every recording to show Ready, then Teach. Boreal owl is listed, switched
   on.
5. Open Devices and wait until the sound list number on every board's card has gone up by one: a board fetches the
   new list after its next check-in, within about a minute. An owl played before that is not reported.
6. Play Boreal owl 1, then Boreal owl 2: each is reported as Boreal owl. Play Tawny owl: it is not.

Afterwards: delete Boreal owl from the sound list and Clear events, so the next rehearsal and the boards start clean.
