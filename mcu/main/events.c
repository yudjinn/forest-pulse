#include "events.h"

#include "esp_log.h"
#include "freertos/queue.h"

static const char *TAG = "events";
static QueueHandle_t s_queue;

void events_init(void)
{
    s_queue = xQueueCreate(16, sizeof(fe_event_t));
    configASSERT(s_queue);
}

bool events_post(fe_evt_type_t type, uint64_t frame)
{
    const fe_event_t ev = {.type = type, .frame = frame};
    if (xQueueSend(s_queue, &ev, 0) != pdTRUE) {
        ESP_LOGE(TAG, "event queue full, dropped type %d", type);
        return false;
    }
    return true;
}

bool events_receive(fe_event_t *out, TickType_t timeout)
{
    return xQueueReceive(s_queue, out, timeout) == pdTRUE;
}
