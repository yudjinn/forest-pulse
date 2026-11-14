#include "trigger.h"

#include <math.h>
#include <stdatomic.h>

#include "driver/gpio.h"
#include "esp_log.h"

#include "board_pins.h"
#include "events.h"
#include "fe_config.h"

static const char *TAG = "trigger";

// ---- Goertzel bank (bins spaced 1000/FE_BLOCK_MS = 50 Hz) -------------------
static const float k_low_hz[] = {100, 150, 200, 250, 300, 350, 400};
static const float k_high_hz[] = {1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000};
static const float k_wind_hz = 50;

#define N_LOW (sizeof k_low_hz / sizeof k_low_hz[0])
#define N_HIGH (sizeof k_high_hz / sizeof k_high_hz[0])

static float s_coeff_low[N_LOW];
static float s_coeff_high[N_HIGH];
static float s_cos_high[N_HIGH], s_sin_high[N_HIGH];
static float s_coeff_wind;
static float s_x[FE_CHANNELS][FE_BLOCK_FRAMES];  // per mic: DC-removed, Hann-windowed, +-1
static float s_win[FE_BLOCK_FRAMES];             // Hann window

static float goertzel_coeff(float hz)
{
    const float k = hz * FE_BLOCK_FRAMES / FE_SAMPLE_RATE;  // integer bin index
    return 2.0f * cosf(2.0f * (float)M_PI * k / FE_BLOCK_FRAMES);
}

static float goertzel_power(const float *x, uint32_t n, float coeff)
{
    float s1 = 0, s2 = 0;
    for (uint32_t i = 0; i < n; i++) {
        const float s0 = x[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

// Complex Goertzel: DFT value at the bin, up to a phase factor that is the
// same for every channel at that bin (so it cancels in cross-spectra).
static void goertzel_cplx(const float *x, uint32_t n, float coeff, float cw, float sw, float *re, float *im)
{
    float s1 = 0, s2 = 0;
    for (uint32_t i = 0; i < n; i++) {
        const float s0 = x[i] + coeff * s1 - s2;
        s2 = s1;
        s1 = s0;
    }
    *re = s1 - s2 * cw;
    *im = s2 * sw;
}

// ---- Tunables (menuconfig) --------------------------------------------------
#define SNR_DB ((float)CONFIG_FE_TRIG_SNR_DB)
#define RATIO_DB ((float)CONFIG_FE_TRIG_BAND_RATIO_DB)
#define ARM_BLOCKS CONFIG_FE_TRIG_ARM_BLOCKS
#define COOLDOWN_BLOCKS (CONFIG_FE_TRIG_COOLDOWN_MS / FE_BLOCK_MS)
#define MAX_POST_FRAMES FE_MS_TO_FRAMES(CONFIG_FE_EVENT_MAX_POST_MS)
#define WARMUP_BLOCKS (2000 / FE_BLOCK_MS)
#define FLOOR_ALPHA_DOWN 0.1f  // fast fall towards quieter background
// A 20 ms DFT bin of noise has only 2 degrees of freedom (+-10 dB swings
// block to block), and the sub-80 Hz band holds ~1.6 bins, so band and wind
// powers are smoothed over ~100 ms before the ratio is taken.
#define SPECTRAL_TAU_MS 100.0f
// Coherence: magnitude-squared coherence (MSC) between mic pairs over the
// 1-3 kHz bins. A distant point source (chainsaw) is coherent across the
// array (MSC -> 1, independent of arrival delay); wind turbulence, rain drops
// and a diffuse hall background are not. A single block's MSC is always 1, so
// cross- and auto-spectra are averaged over ~COHERENCE_TAU_MS first.
#define COHERENCE_MIN ((float)CONFIG_FE_TRIG_COHERENCE_PCT / 100.0f)
#define COHERENCE_TAU_MS ((float)CONFIG_FE_TRIG_COHERENCE_TAU_MS)
#if CONFIG_FE_SOURCE_SYNTH
#define COHERENCE_GATE 0  // synthetic ch2/ch3 carry frame counters, not audio
#else
#define COHERENCE_GATE (CONFIG_FE_TRIG_COHERENCE_PCT > 0)
#endif

// ---- State --------------------------------------------------------------------
static trig_state_t s_state = TRIG_WARMUP;
static float s_floor_rms;
static float s_floor_alpha_up;
static uint32_t s_warmup_blocks;
static uint32_t s_arm_count;
static uint32_t s_quiet_blocks;
static uint64_t s_trigger_frame;
static bool s_continuous;
static float s_spec_alpha;
static float s_band_smooth, s_wind_smooth;
static float s_power_smooth;  // mic1 mean-square level, ~100 ms EMA (level gate)
static float s_floor_alpha_long;  // floor rise on positive blocks while re-arming
static float s_coh_alpha;
static float s_auto[FE_CHANNELS][N_HIGH];       // smoothed |X|^2 per mic per bin
static float s_cross_re[3][N_HIGH], s_cross_im[3][N_HIGH];  // pairs 12, 13, 23
static volatile float s_last_rms, s_last_ratio_db, s_last_coherence;
static volatile uint32_t s_events;

static atomic_bool s_req_force;
static atomic_int s_req_cont;  // 0 none, 1 start, 2 stop

static float to_db(float lin)
{
    return 20.0f * log10f(lin > 1e-9f ? lin : 1e-9f);
}

static void wake_set(int level)
{
#if PIN_WAKE >= 0
    gpio_set_level(PIN_WAKE, level);
#else
    (void)level;
#endif
}

void trigger_init(void)
{
    for (size_t i = 0; i < N_LOW; i++) {
        s_coeff_low[i] = goertzel_coeff(k_low_hz[i]);
    }
    for (size_t i = 0; i < N_HIGH; i++) {
        s_coeff_high[i] = goertzel_coeff(k_high_hz[i]);
        const float w = 2.0f * (float)M_PI * k_high_hz[i] / FE_SAMPLE_RATE;
        s_cos_high[i] = cosf(w);
        s_sin_high[i] = sinf(w);
    }
    s_coeff_wind = goertzel_coeff(k_wind_hz);
    // Hann window: rectangular-window leakage (-13 dB sidelobes) would let an
    // off-bin engine harmonic spill into the 50 Hz "wind" bin.
    for (uint32_t i = 0; i < FE_BLOCK_FRAMES; i++) {
        s_win[i] = 0.5f - 0.5f * cosf(2.0f * (float)M_PI * i / FE_BLOCK_FRAMES);
    }
    s_spec_alpha = 1.0f - expf(-(float)FE_BLOCK_MS / SPECTRAL_TAU_MS);
    // EMA rise rate for a time constant of CONFIG_FE_TRIG_FLOOR_TAU_S seconds.
    s_floor_alpha_up = 1.0f - expf(-(FE_BLOCK_MS / 1000.0f) / CONFIG_FE_TRIG_FLOOR_TAU_S);
    s_floor_alpha_long = 1.0f - expf(-(FE_BLOCK_MS / 1000.0f) / CONFIG_FE_TRIG_FLOOR_LONG_TAU_S);
    s_coh_alpha = 1.0f - expf(-(float)FE_BLOCK_MS / COHERENCE_TAU_MS);

#if PIN_WAKE >= 0
    gpio_config_t io = {.pin_bit_mask = 1ULL << PIN_WAKE, .mode = GPIO_MODE_OUTPUT};
    ESP_ERROR_CHECK(gpio_config(&io));
#endif
    wake_set(0);
}

// DC-remove and window one channel into s_x[ch]; returns its (unwindowed) RMS.
static float prepare_channel(const int16_t *block, uint32_t n, uint32_t ch)
{
    float mean = 0;
    for (uint32_t i = 0; i < n; i++) {
        mean += block[i * FE_CHANNELS + ch];
    }
    mean /= n;
    float energy = 0;
    for (uint32_t i = 0; i < n; i++) {
        const float v = (block[i * FE_CHANNELS + ch] - mean) * (1.0f / 32768.0f);
        s_x[ch][i] = v * s_win[i];
        energy += v * v;
    }
    return sqrtf(energy / n);
}

// Update smoothed spectra for the 1-3 kHz bins of all mics and return the
// mean magnitude-squared coherence over the three mic pairs. Also returns
// mic1's summed 1-3 kHz power for this block (reused by the spectral gate).
static float update_coherence(uint32_t n, float *mic1_high_power)
{
    *mic1_high_power = 0;
    static const uint8_t pair[3][2] = {{0, 1}, {0, 2}, {1, 2}};
    float msc_sum = 0;
    for (size_t k = 0; k < N_HIGH; k++) {
        float re[FE_CHANNELS], im[FE_CHANNELS];
        for (uint32_t ch = 0; ch < FE_CHANNELS; ch++) {
            goertzel_cplx(s_x[ch], n, s_coeff_high[k], s_cos_high[k], s_sin_high[k], &re[ch], &im[ch]);
            const float p = re[ch] * re[ch] + im[ch] * im[ch];
            s_auto[ch][k] += s_coh_alpha * (p - s_auto[ch][k]);
            if (ch == 0) {
                *mic1_high_power += p;
            }
        }
        for (int p = 0; p < 3; p++) {
            const int a = pair[p][0], b = pair[p][1];
            // X_a * conj(X_b)
            const float cr = re[a] * re[b] + im[a] * im[b];
            const float ci = im[a] * re[b] - re[a] * im[b];
            s_cross_re[p][k] += s_coh_alpha * (cr - s_cross_re[p][k]);
            s_cross_im[p][k] += s_coh_alpha * (ci - s_cross_im[p][k]);
            const float num = s_cross_re[p][k] * s_cross_re[p][k] + s_cross_im[p][k] * s_cross_im[p][k];
            const float den = s_auto[a][k] * s_auto[b][k] + 1e-30f;
            msc_sum += num / den;
        }
    }
    return msc_sum / (3.0f * N_HIGH);
}

// Returns true if this block looks like chainsaw/machinery.
static bool evaluate(const int16_t *block, uint32_t n)
{
    const float rms = prepare_channel(block, n, 0);  // mic1 drives the level + spectral gates
    prepare_channel(block, n, 1);
    prepare_channel(block, n, 2);
    float high_power;
    const float coherence = update_coherence(n, &high_power);

    float band = high_power;
    for (size_t i = 0; i < N_LOW; i++) {
        band += goertzel_power(s_x[0], n, s_coeff_low[i]);
    }
    band /= (float)(N_LOW + N_HIGH);
    const float wind = goertzel_power(s_x[0], n, s_coeff_wind);
    s_band_smooth += s_spec_alpha * (band - s_band_smooth);
    s_wind_smooth += s_spec_alpha * (wind - s_wind_smooth);
    const float ratio_db = 10.0f * log10f((s_band_smooth + 1e-12f) / (s_wind_smooth + 1e-12f));

    // Level gate uses a ~100 ms smoothed level: single 20 ms blocks swing by
    // +-3 dB, which would break the N-consecutive-blocks debounce.
    s_power_smooth += s_spec_alpha * (rms * rms - s_power_smooth);
    const float level = sqrtf(s_power_smooth);

    s_last_rms = level;
    s_last_ratio_db = ratio_db;
    s_last_coherence = coherence;

    if (s_state == TRIG_WARMUP) {
        // Running mean of the first blocks seeds the floor.
        s_floor_rms += (rms - s_floor_rms) / (float)(s_warmup_blocks + 1);
        return false;
    }
    const bool gate = to_db(level) > to_db(s_floor_rms) + SNR_DB;
    const bool spectral = ratio_db > RATIO_DB;
    const bool coherent = !COHERENCE_GATE || coherence > COHERENCE_MIN;
    const bool positive = gate && spectral && coherent;

    // Noise floor: never adapts during an event. On background blocks it falls
    // fast / rises slowly - but it does NOT rise while a coherent (directional)
    // sound is present, or a source that is still below the level margin
    // would drag the floor up behind it and never trigger (seen in the hall).
    // While re-arming, positive blocks pull it up slowly, so a persistent
    // sound (PA, fan, steady machinery) becomes background instead of
    // blocking detection forever.
    if (s_state != TRIG_ACTIVE) {
        float a = 0;
        if (!positive) {
            if (rms < s_floor_rms) {
                a = FLOOR_ALPHA_DOWN;
            } else if (!(COHERENCE_GATE && coherent)) {
                a = s_floor_alpha_up;
            }
        } else if (s_state == TRIG_REARM) {
            a = s_floor_alpha_long;
        }
        s_floor_rms += a * (rms - s_floor_rms);
    }
    return positive;
}

static void start_event(uint64_t frame, bool continuous)
{
    s_state = TRIG_ACTIVE;
    s_trigger_frame = frame;
    s_quiet_blocks = 0;
    s_continuous = continuous;
    s_events++;
    wake_set(1);
    events_post(FE_EVT_START, frame);
}

static void end_event(uint64_t frame)
{
    events_post(FE_EVT_END, frame);
    wake_set(0);
    s_state = TRIG_REARM;
    s_quiet_blocks = 0;
    s_continuous = false;
}

void trigger_process(const int16_t *block, uint32_t n, uint64_t end_frame)
{
    const bool positive = evaluate(block, n);
    const int cont_req = atomic_exchange(&s_req_cont, 0);
    const bool force_req = atomic_exchange(&s_req_force, false);

    if (s_state != TRIG_ACTIVE && (force_req || cont_req == 1)) {
        start_event(end_frame, cont_req == 1);
        return;
    }

    switch (s_state) {
    case TRIG_WARMUP:
        if (++s_warmup_blocks >= WARMUP_BLOCKS) {
            s_state = TRIG_IDLE;
            ESP_LOGI(TAG, "noise floor %.1f dBFS, armed", to_db(s_floor_rms));
        }
        break;

    case TRIG_IDLE:
    case TRIG_ARMING:
        if (positive) {
            if (++s_arm_count >= ARM_BLOCKS) {
                s_arm_count = 0;
                start_event(end_frame, false);
            } else {
                s_state = TRIG_ARMING;
            }
        } else {
            s_arm_count = 0;
            s_state = TRIG_IDLE;
        }
        break;

    case TRIG_ACTIVE:
        if (s_continuous) {
            if (cont_req == 2) {
                end_event(end_frame);
            }
            break;
        }
        s_quiet_blocks = positive ? 0 : s_quiet_blocks + 1;
        if (s_quiet_blocks >= COOLDOWN_BLOCKS || end_frame - s_trigger_frame >= MAX_POST_FRAMES ||
            cont_req == 2) {
            end_event(end_frame);
        }
        break;

    case TRIG_REARM:
        // Require a full cooldown of quiet before a new event can arm, so a
        // capped event on a still-running saw does not instantly re-trigger.
        s_quiet_blocks = positive ? 0 : s_quiet_blocks + 1;
        if (s_quiet_blocks >= COOLDOWN_BLOCKS) {
            s_state = TRIG_IDLE;
        }
        break;
    }
}

void trigger_request_force(void)
{
    atomic_store(&s_req_force, true);
}

void trigger_request_continuous(bool start)
{
    atomic_store(&s_req_cont, start ? 1 : 2);
}

void trigger_get_stats(trig_stats_t *out)
{
    out->state = s_state;
    out->rms_dbfs = to_db(s_last_rms);
    out->floor_dbfs = to_db(s_floor_rms);
    out->ratio_db = s_last_ratio_db;
    out->coherence = s_last_coherence;
    out->events = s_events;
}

const char *trigger_state_name(trig_state_t s)
{
    static const char *const names[] = {"warmup", "idle", "arming", "active", "rearm"};
    return (unsigned)s < sizeof names / sizeof names[0] ? names[s] : "?";
}
