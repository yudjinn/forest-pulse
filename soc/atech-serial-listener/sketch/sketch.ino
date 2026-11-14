// MCU (STM32) side.
//
// 1. Watches the ESP32's trigger line on header pin D7 ("comms about to
//    begin") and tells Python on every edge: Bridge.notify("trigger_pin", 0/1).
// 2. Receives event summaries from Python: Bridge.notify("serial_event", line)
//    calls serial_event() below.
//
// Callbacks only store data; the work happens in loop(), and loop() never
// blocks, so the trigger pin is polled continuously.

#include <Arduino_RouterBridge.h>

const int TRIGGER_PIN = 7;
const unsigned long DEBOUNCE_MS = 2;
const unsigned long LED_FLASH_MS = 50;
const unsigned long TRIGGER_RESEND_MS = 1000;  // Python may start after us

volatile bool hasEvent = false;
String lastLine;

int triggerState = -1;          // -1 = not reported yet
int triggerCandidate = LOW;
unsigned long triggerChangedAt = 0;
unsigned long ledOffAt = 0;
unsigned long triggerSentAt = 0;

void serial_event(String line) {
  lastLine = line;
  hasEvent = true;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  pinMode(TRIGGER_PIN, INPUT);  // driven by the ESP32
  Bridge.begin();
  Monitor.begin();
  Bridge.provide("serial_event", serial_event);
}

void loop() {
  unsigned long now = millis();

  // Trigger pin: report the first reading, then every debounced edge.
  int level = digitalRead(TRIGGER_PIN);
  if (level != triggerCandidate) {
    triggerCandidate = level;
    triggerChangedAt = now;
  }
  if (triggerCandidate != triggerState && (triggerState == -1 || now - triggerChangedAt >= DEBOUNCE_MS)) {
    triggerState = triggerCandidate;
    Bridge.notify("trigger_pin", triggerState);
    triggerSentAt = now;
    Monitor.print("trigger pin D7: ");
    Monitor.println(triggerState ? "HIGH" : "LOW");
  } else if (triggerState != -1 && now - triggerSentAt >= TRIGGER_RESEND_MS) {
    // Periodic resend of the current level; Python only logs changes.
    Bridge.notify("trigger_pin", triggerState);
    triggerSentAt = now;
  }

  if (hasEvent) {
    hasEvent = false;
    Monitor.print("SoC saw: ");
    Monitor.println(lastLine);
    // Flash the LED on every message (non-blocking).
    digitalWrite(LED_BUILTIN, HIGH);
    ledOffAt = now + LED_FLASH_MS;
  }
  if (ledOffAt && (long)(now - ledOffAt) >= 0) {
    digitalWrite(LED_BUILTIN, LOW);
    ledOffAt = 0;
  }

  // To talk back to the ESP32 via the SoC (single-byte commands I/T/C/X):
  // Bridge.notify("send_to_board", "I");
}
