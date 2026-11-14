#pragma once
// Event notifications from the capture/trigger task (core 0) to the stream
// task (core 1). Posting never blocks.

#include <stdbool.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"

typedef enum {
    FE_EVT_START = 1,  // frame = trigger frame (pre-trigger window ends here)
    FE_EVT_END = 2,    // frame = one past the last frame of the event
} fe_evt_type_t;

typedef struct {
    fe_evt_type_t type;
    uint64_t frame;
} fe_event_t;

void events_init(void);
bool events_post(fe_evt_type_t type, uint64_t frame);
bool events_receive(fe_event_t *out, TickType_t timeout);
