#pragma once
// Stream task (core 1): host command handling + event packetizer that reads
// the PSRAM ring and writes framed packets to USB-Serial/JTAG.
//
// Host commands (single ASCII bytes):
//   I  status line           B+u32  throughput bench (idle only)
//   T  force trigger         C / X  start / stop continuous event
//   S / s  synthetic chainsaw sound on / off

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

TaskHandle_t stream_start(void);
