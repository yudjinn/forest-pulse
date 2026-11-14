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

// Runtime trigger thresholds. Boot defaults come from menuconfig
// (CONFIG_FE_TRIG_SNR_DB / _BAND_RATIO_DB / _COHERENCE_PCT); the host can
// change them at any time (stream command 'G'). They are not stored: the host
// re-sends them after every reset.
typedef struct {
    float snr_db;         // level gate: block RMS above the noise floor by more than this (dB)
    float ratio_db;       // spectral gate: band energy over wind energy above this (dB)
    float coherence_min;  // coherence gate: inter-mic MSC (1-3 kHz) above this; 0 = gate off
} trig_params_t;

#define TRIG_PARAM_SNR 'S'
#define TRIG_PARAM_RATIO 'R'
#define TRIG_PARAM_COHERENCE 'C'

// Sets one threshold (id = TRIG_PARAM_*). False (unchanged) if the id is
// unknown or the value is out of range: snr 0..40 dB, ratio -30..30 dB,
// coherence 0..0.99.
bool trigger_set_param(char id, float value);
void trigger_get_params(trig_params_t *out);
void trigger_get_default_params(trig_params_t *out);  // the menuconfig boot values
const char *trigger_state_name(trig_state_t s);
