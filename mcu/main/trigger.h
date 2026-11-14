#pragma once
// Two-stage acoustic trigger (adaptive RMS gate + Goertzel band ratio) and
// the event state machine. Runs in the capture task, once per 20 ms block.

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    TRIG_WARMUP = 0,  // learning the noise floor, cannot trigger
    TRIG_IDLE,
    TRIG_ARMING,  // consecutive positive blocks being counted
    TRIG_ACTIVE,  // event in progress, WAKE high
    TRIG_REARM,   // event ended; waiting for quiet before next event
} trig_state_t;

typedef struct {
    trig_state_t state;
    float rms_dbfs;    // last block RMS
    float floor_dbfs;  // adaptive noise floor
    float ratio_db;    // last block band-energy / wind-energy ratio
    float coherence;   // smoothed mean inter-mic MSC over 1-3 kHz (0..1)
    float tone_db;     // TEST: test-tone bin over its neighbours (-99 when the test mode is off)
    uint32_t events;   // events started since boot
} trig_stats_t;

void trigger_init(void);

// Evaluate one block. `block` is interleaved [m1,m2,m3] x n frames;
// `end_frame` is the ring index one past the block's last frame.
void trigger_process(const int16_t *block, uint32_t n, uint64_t end_frame);

// Host test hooks (callable from any task).
void trigger_request_force(void);            // start an event now
void trigger_request_continuous(bool start);  // start/stop an uncapped event

void trigger_get_stats(trig_stats_t *out);
const char *trigger_state_name(trig_state_t s);
