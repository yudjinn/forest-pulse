# Location calibration — integration notes (superseded)

**Superseded by upstream.** The calibration run, the protocol and the solver are implemented upstream and documented there; that is the source of truth:
- [`docs/device-api.md`](docs/device-api.md), "Calibration": the run (check-in reply, ready, `start_at`, slots, report) and the two- and three-sensor solve.
- [`sensor-sdk/README.md`](sensor-sdk/README.md), "Calibration hooks", and `sensor-sdk/forestpulse_sensor/calibration/`: what the node app must provide.
- The method background stays in `LocationCalbrationSpec.md`.

## Node side (soc/atech-serial-listener)
`sdk_glue.CalibrationHooks` implements the SDK's hooks and passes its `self_check()`; see the app README, "Location calibration". Hardware: the Modulino Buzzer on the Qwiic chain plays the sweeps (sketch Bridge `emit`), the Modulino Thermo gives the speed of sound, the ESP32's `C`/`X` commands give the continuous stream.

## Where our earlier proposal differed from what upstream built
Recorded so nobody builds against the old proposal:

| Topic | Our proposal (earlier version of this file) | Upstream (current) |
|---|---|---|
| Sounds | one shared 300 ms rising sweep; beeps told apart by time slot | a different sweep per role (A rises, B falls, C rises and falls), 120 ms, sent by the service with each run |
| Group size | N nodes | at most 3 participants, roles A, B, C; a pair is solved when only two run |
| Reference point | mic2: arrival times at mic2, buzzer offset to mic2, position = mic2 | the array's centre: arrival = mean over the 3 mics, buzzer offset to the centre, position = the array's centre |
| Bearing window | ~30–80 ms (or the whole beep) | 40 ms from 5 ms before the first path; each call under 200 ms |
| Stream start | send `C` | end any running recording first (we send `X`, wait 100 ms, then `C`) |
| Timing | NTP clocks, ±250 ms slots, anchored on the first heard beep | the board's clock corrected to the service's (`server_time` in the reply); `start_at` 6 s after the last ready; check-ins every 1 s during a run |
