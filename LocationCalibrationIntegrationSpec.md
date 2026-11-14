# Location calibration — integration spec (node ↔ SDK ↔ server)

Companion to `LocationCalbrationSpec.md` (the method). This document says **how it maps onto our system** and **who builds what**. Agreed so far:

- **Group of N nodes.** The server says how big the group is and which position each node has: "group size 3, you are node 3".
- **One shared sound.** Every node plays the **same rising sweep** (1.5 → 3.5 kHz, 300 ms). Nodes take turns in **500 ms slots**, and a beep is attributed to a node by **which slot it falls in**, not by its sound. This replaces the method spec's per-node patterns.
- **Emitter**: one Modulino Buzzer per node, on the Qwiic chain next to the Modulino Thermo, mounted right next to the mic array. Verified on node fp-14b5cd0f3999: audible, about −17 dBFS peak on all 3 mics at that distance (no clipping).
- **Demo**: tabletop/stage, nodes < 8 m apart.
- **Detection and calibration logic live in the sensor SDK** (`sensor-sdk/`, `forestpulse_sensor`).
- **Server endpoints and the solver**: server team.
- **Node app** (`soc/atech-serial-listener`): hardware adapter only. It provides the stream, buzzer, speed of sound and bearing as hooks the SDK calls.

The result feeds the ADR (`docs/adr/20261114112557541.md`): the server needs each sensor's position and facing on the plan before it can cross bearings.

---

## 1. How the method works on our hardware

1. **Each node uses its own clock; there is no shared "frame0".**
   - Each node timestamps every beep as a **sample index on its own continuous stream**, from the ESP32 mic clock. It does not use Linux time or CPU cycles.
   - Nodes hear the same beep at different moments (offset by distance / c). That's fine, because two-way ranging only uses time differences on one node's own clock. For any pair i, j where i beeped first:
     `d_ij = c/2 · [(t_i(j) − t_i(i)) − (t_j(j) − t_j(i))] + (s_i + s_j)/2`
2. **Every node must detect its own beep.** That is half of the formula for every pair it belongs to.
3. **Beep start times don't need to be precise.** Latency from Wi-Fi, Bridge, I2C and buzzer onset cancels, because every node hears the same beep. The slot schedule only has to keep beeps from overlapping and from leaving their slot.
4. **Which slot a beep belongs to comes from its time, not from counting** (§6). Counting ("two beeps so far, so I'm next") would let one missed beep shift every later node. With time slots, a missed beep only leaves a gap.
   - Tolerance: ±250 ms around a slot's centre.
   - Everything that shifts a beep is far smaller: travel over 8 m is 23 ms, Bridge/I2C/buzzer latency is tens of ms, NTP is tens of ms (the board's clock is NTP-synchronised).
5. **Crystal drift** (sample-rate ppm) adds about `c/2 · Δε · Δt_ij`, where Δt_ij is the gap between the two beeps of a pair.
   - Δt_ij is at most (N−1) × 0.5 s: about 3 mm for N = 2 and about 3 cm for N = 10, small next to the buzzer's ±15 cm target.
   - Alternating rounds forward and reverse (§6) cancels it to first order. Use the median over ≥ 4 rounds.
6. **The stream must be unbroken** from before the first beep to after the last.
   - Any break (seq gap, ESP32 ring overrun, capture sync loss, or an SDK queue drop) invalidates that node's round.
   - A break is reported, never bridged.
7. **No bearing for a node's own beep** (near field, meaningless).
8. **Results are relative:** node 1 is at (0, 0) facing 0°, node 2 is on +x, and the bearings resolve the mirror. To place nodes on the plan, the user enters one anchor, e.g. node 1's plan position and facing. The scale is real metres from acoustics.
9. **Not every pair has to work.** With N nodes, a pair that can't hear each other (too far, blocked) drops out. The solve needs every node connected to the group through enough working pairs (§7).

---

## 2. Ownership

| Piece | Owner | Notes |
|---|---|---|
| ESP32 continuous stream (`C` / `X`), break flags | node (done) | `mcu/`, nothing new |
| Calibration hooks (stream on/off, emit, speed of sound, bearing, geometry) | **node app (done)** | `sdk_glue.CalibrationHooks`, §3 |
| Buzzer playback | **node app (done, verified)** | `sketch.ino`: Bridge `emit`, §4 |
| Pausing the node's own event pipeline while calibrating | **node app (done)** | the stream still feeds the SDK |
| Command from server (check-in reply), slot scheduling, beeping in our slot | **SDK** | §5, §6 |
| Detection: online coarse detector, slot assignment, stop control, precise arrival times, report | **SDK** | §6 |
| Suppress normal sound events while calibrating | **SDK** | a buzzer must not be reported as "Tools" |
| Group membership, positions, run coordination, N-node solver, anchoring on the plan, UI | **server** | §5, §7 |

---

## 3. Node ↔ SDK contract: `CalibrationHooks`

The node app passes an object to the SDK: `Sensor(..., calibration=hooks)`, or `Sensor.from_file(path, angle_fn=..., calibration=hooks)`. The app only passes it if `Sensor.__init__` accepts a `calibration` parameter, so older SDKs keep working.

```python
class CalibrationHooks:
    # --- static facts (attributes) ---
    fs: int                        # 48000
    emitter_offset_m: float        # s_i: buzzer to array centre, ruler-measured (config.json calibration.emitter_offset_cm)
    mic_positions_m: list          # [[x, y], ...] board frame, metres (informational; the node does the bearing)
    forward_ccw_deg: float         # board's marked forward in the board frame (angle convention below)

    # --- stream control ---
    def start_stream(self) -> bool:
        """Begin continuous raw capture (ESP32 'C'). Audio keeps arriving through Sensor.feed() exactly as now:
        (N, 3) int16 at 48 kHz, break_before=True on any discontinuity. Also pauses the node's own event
        pipeline. Returns False if the ESP32 isn't connected (abort the run, report 'no_stream')."""
    def stop_stream(self) -> None:
        """End continuous capture (ESP32 'X'); the node's own pipeline resumes after the stream ends."""

    # --- emitter ---
    def emit(self, f_start_hz: int, f_mid_hz: int, f_end_hz: int, duration_ms: int) -> None:
        """Play a stepped sweep on the buzzer: f_start -> f_mid over the first half, f_mid -> f_end over the
        second half. The shared calibration sweep is emit(1500, 2500, 3500, 300): a straight rise.
        Non-blocking; start-time jitter is irrelevant (cancels). The shape repeats from call to call (1 ms steps)."""

    # --- physics / direction ---
    def speed_of_sound(self) -> float:
        """m/s from the node's Modulino Thermo (343.0 if absent). Include it in the report."""
    def bearing(self, window, band_hz: tuple[float, float] | None = None):
        """Direction of ONE arrival. window: (N, 3) int16 covering the beep's first part (e.g. the first
        50-300 ms after the detected first path, before strong echoes build up).
        band_hz: the sweep's band (default 1000-4000 Hz). Returns (angle_deg, quality) or None.
        angle_deg: clockwise from the board's forward, 0-360 (same convention as angle_fn / the event API).
        quality: 0..1 (SRP-PHAT peak sharpness, gated on inter-pair delay consistency)."""
```

Threading: every hook may be called from any SDK thread. None of them block for more than a few ms except `bearing()`, which is about 10–50 ms of numpy.

**SDK requirements for timing:**
- Count the samples it is fed, from `start_stream()` onwards, as the run's time base.
- Mark any internal drop (`MAX_BACKLOG_S`) as a break.
- During calibration it must never drop silently.

---

## 4. The sound: one shared sweep

The Modulino Buzzer is a passive buzzer behind a small I2C controller: `tone(freq_hz, len_ms)`. The sketch plays a sweep as `tone()` steps 1 ms apart.

| Parameter | Value | Why |
|---|---|---|
| Sweep | rising 1500 → 3500 Hz, linear | `emit(1500, 2500, 3500, 300)`; already tested on hardware |
| Length | 300 ms | about 10× the energy of the method spec's 30 ms chirps: more robust detection, longer bearing window |
| Slot | 500 ms | 300 ms of sweep + 200 ms for echoes, travel and jitter |
| Template | the synthetic sweep at first; better, each node's own recorded beep (round 1, its own slot) | the exact waveform doesn't matter as long as it repeats |

Every node plays the same sound, so beeps are told apart only by their slot. Slots must therefore never overlap, which is why emission timing is anchored and checked (§6).

Re-centre the band on the buzzer's measured response if needed (the method spec's M2 sweep). The node needs no change: the band comes from the server's `sweep` field.

---

## 5. Server ↔ SDK protocol (proposal; the server team owns it)

No websocket is needed. Timing cancels out, so nodes can fire on their own clocks.

**Check-in reply** (every 10 s), when the server wants this node in a group:

```jsonc
"calibration": {
  "run_id": "cal-2026-11-14-01",
  "group_size": 3,                          // N
  "position": 3,                            // this node's slot in a forward round, 1..N
  "start_at": "2026-11-14T12:00:15.000Z",   // start of slot 1 of round 1 (wall clock, NTP)
  "slot_ms": 500,
  "round_gap_ms": 1000,                     // silence between rounds
  "rounds": 4,                              // odd rounds forward, even rounds reverse
  "sweep": [1500, 2500, 3500, 300]          // emit() args, same for every node
}
```

- **Ready / ack**: the node's next check-in carries `"calibration_ack": "<run_id>"`. The server sets `start_at` ≈ 15 s after the **last** node's ack and resends the field until it's past.
- **Cancel**: the field disappears, or carries `"cancel": true`.
- **Mapping**: only the server knows which sensor holds which position. Reports use slot numbers; the server maps them back.

**Report**: `POST /api/v1/sensors/<id>/calibration/<run_id>`

```jsonc
{"run_id":"…","group_size":3,"position":3,"fs":48000,"speed_of_sound":347.2,"emitter_offset_m":0.03,
 "anchor":"heard",                          // "heard" (first beep heard) or "clock" (start_at fallback)
 "rounds":[
   {"round":1,"direction":"forward","valid":true,"breaks":0,"clipped":false,
    "detections":[
      {"slot":1,"self":false,"t_samples":123460012.37,"snr":28.5,"slot_offset_ms":-12.0,
       "angle_deg":231.0,"angle_q":0.82},
      {"slot":2,"self":false,"t_samples":123484003.10,"snr":25.9,"slot_offset_ms":4.1,
       "angle_deg":12.5,"angle_q":0.77},
      {"slot":3,"self":true, "t_samples":123508590.10,"snr":51.2,"slot_offset_ms":-3.3}]}],
 "errors":[]}
```

- `slot` is the slot **in that round**. In a reverse round, slot s is played by position N − s + 1.
- `t_samples` counts from `start_stream()` and only means something within this node's report.
- `slot_offset_ms` is how far the detection was from where its slot predicted (a health check: it should stay well under ±250 ms).
- A missing detection is left out, not guessed.
- `valid: false` if there was any break in the round window, or clipping.

---

## 6. Inside the SDK: slots, anchor, streaming and stop control

The audio streams in; it is not handed over as a file. Recommended structure:

1. **Schedule.**
   - Round r (1-based) starts at `start_at + (r−1) × (N × slot_ms + round_gap_ms)`.
   - Within a round, slot s starts at `round_start + (s−1) × slot_ms`.
   - This node plays in slot `position` on forward (odd) rounds, and in slot `N − position + 1` on reverse (even) rounds.
2. **Capture.**
   - About 2 s before `start_at`, call `start_stream()`.
   - Fed audio goes into a ring holding the whole run, indexed by the absolute sample count, with breaks recorded. For N = 3 and 4 rounds that's about 10 s plus margins: 20 s × 3 ch ≈ 6 MB.
   - Pause normal classification and events.
   - Map samples to wall time once: `wall(sample) = wall_at_start_stream + (sample − 0) / fs`. Used only for the clock fallback and scheduling; never for ranging.
3. **Anchor** (the time of the start of slot 1 of the current round, on this node's sample clock):
   - **Preferred:** the first beep heard in the round's first slot window, minus its expected offset into the slot (~0). Because everyone heard the same beep, every node is then within travel time (≤ 23 ms) of the others.
   - **Fallback** if nothing was heard there: `start_at` (or the scheduled round start) through the wall-time mapping. Report `"anchor": "clock"`.
   - Re-anchor every round, on the round's first heard beep.
4. **Emitting:** at anchor + (my_slot − 1) × slot_ms, call `emit(*sweep)`. For the first slot (or if not anchored yet), use the wall-clock schedule. Start-time jitter is irrelevant; it only has to stay inside the slot.
5. **Online coarse detector,** every 20 ms block: mic1 matched filter against the sweep template (numpy FFT). A peak above threshold → a coarse detection at `~sample`.
6. **Slot assignment:** `slot = round((t − anchor) / slot_ms) + 1`, using the detection's start.
   - Reject a detection whose distance from its slot's start is more than ±250 ms, or a second detection in a slot already filled (an echo). Keep the stronger first path.
   - The node's own slot is self (and should be by far the loudest).
7. **Stop control** (driven by the known schedule, so no server message is needed):
   - **Stop** after the last slot of the last round, plus 300 ms for the tail.
   - **Hard timeout**: the end of the schedule + 1 s.
   - A break inside a round → that round is `valid: false`. Keep going.
   - Own beep not heard in a round → report it. The server may retry, up to 2 times (method spec §5).
   - Then call `stop_stream()`.
8. **Precise pass**, per coarse detection, on a slice from the ring:
   - Band-pass, then matched filter on all 3 mics.
   - **First path**, not the global max (method spec §8).
   - Parabolic sub-sample refinement.
   - `t_samples` = mean of the 3 mics.
   - SNR.
   - For other nodes' beeps: `hooks.bearing(slice, band)` on the early part of the beep.
9. POST the report, then resume normal operation.

---

## 7. Server: N-node solver (method spec §3.4, §9)

- **Pairwise distances**: for every pair (i, j) where both nodes heard both beeps in a valid round, apply the formula in §1, with i = whichever played first in that round. Take the median over rounds and check forward/reverse consistency.
- **Joint least squares** over every node's (x, y, h), fixing node 1 at (0, 0, 0) and node 2's y at 0. Use distance residuals for every working pair and bearing residuals for every working (listener, beeper) combination.
  - σ for a buzzer: σ_d = 0.15 m, σ_β = 12°.
  - Initial guess: place node 2 on +x, then add the other nodes one at a time by trilateration from already-placed nodes, trying both mirror candidates. Keep the lowest cost; report `mirror_confidence`.
- **Connectivity**: if some node has fewer than 2 working pairs to already-placed nodes, flag it ("not enough links") instead of guessing.
- **Angle convention**: the reported `angle_deg` is **clockwise** from the node's marked forward. Convert it to the solver's CCW convention: `β = −angle_deg`.
- **Anchor to the plan**: rotate and translate so node 1 matches its user-entered plan position and facing. Store each node's position and facing for the existing bearing-crossing logic.
- **Flags**: degenerate triangles (smallest angle < 10°), triangle inequality, bearing/distance angle mismatch, forward/reverse mismatch, slot offsets beyond ±150 ms (a node's clock or anchor is off).

---

## 8. Test plan

| Step | Who | Check |
|---|---|---|
| Hook unit tests with a fake SDK | node (done) | `soc/dev` pytest: C/X sent, the pipeline pauses and resumes, `bearing()` on a synthetic sweep within 5° |
| Buzzer on one node | node (done) | the sweep is audible and heard by its own array, no clipping |
| Bearing of another node's buzzer | node | at known angles within 15° (use the README test-tone table layout) |
| Detector + slot assignment on the simulator | SDK | arrival error < 0.1 sample at 30 dB SNR; correct first path with reflections; a dropped beep never shifts other slots |
| Two-node ranging at 1, 2 and 4 m | SDK + node | within ±15 cm |
| Three nodes, taped triangle | all | positions ±20 cm, headings ±15°, no mirror errors in 20 runs |
| N > 3 (if hardware allows) | all | same targets; a node out of range is flagged, not misplaced |

## 9. Open items

- Measure s_i per node (`calibration.emitter_offset_cm`, default 3 cm).
- Confirm that the I2C step rate (Wire1 speed) gives clean 1 ms steps (it sounds fine; check the spectrum).
- Server: where the plan anchor (node 1's position and facing) is entered.
- SDK: the hook for the check-in reply field (`_sync_loop` currently reads only `sound_list_version`).
