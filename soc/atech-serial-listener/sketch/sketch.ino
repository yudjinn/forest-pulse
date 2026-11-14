// MCU (STM32) side of the Uno Q node.
//
// 1. Watches the ESP32's notify line on header pin D7 ("event in progress")
//    and reports every edge to Python: Bridge.notify("trigger_pin", 0/1).
// 2. Shows the direction arrow Python renders: Bridge "led_frame" delivers a
//    104-char '0'/'1' string (8 rows x 13 columns, row-major); "" clears.
// 3. Reads the Modulino Thermo (Qwiic) every 5 s and reports
//    Bridge.notify("climate", temp_c, rh_percent) for the speed of sound.
//    Without a Modulino, Python falls back to 343 m/s.
// 4. Receives one-line event summaries (Bridge "serial_event") and blinks the LED.
//
// Callbacks only store data; the work happens in loop(), and loop() never
// blocks, so the trigger pin is polled continuously.

#include <Arduino_LED_Matrix.h>
#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>

const int TRIGGER_PIN = 7;
const unsigned long DEBOUNCE_MS = 2;
const unsigned long LED_FLASH_MS = 50;
const unsigned long TRIGGER_RESEND_MS = 1000;  // Python may start after us
const unsigned long CLIMATE_PERIOD_MS = 5000;
const int MATRIX_PIXELS = 8 * 13;

Arduino_LED_Matrix matrix;
ModulinoThermo thermo;
bool thermoOk = false;

volatile bool hasEvent = false;
String lastLine;
volatile bool hasFrame = false;
String pendingFrame;
uint8_t frame[MATRIX_PIXELS];

int triggerState = -1;  // -1 = not reported yet
int triggerCandidate = LOW;
unsigned long triggerChangedAt = 0;
unsigned long ledOffAt = 0;
unsigned long triggerSentAt = 0;
unsigned long climateAt = 0;

void serial_event(String line) {
  lastLine = line;
  hasEvent = true;
}

void led_frame(String bits) {
  pendingFrame = bits;
  hasFrame = true;
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  // Driven by the ESP32 (3.3 V push-pull). The pull-down keeps the pin LOW
  // when the ESP32 isn't wired up - a floating input toggled every ~30 ms.
  pinMode(TRIGGER_PIN, INPUT_PULLDOWN);
  Bridge.begin();
  Monitor.begin();
  Bridge.provide("serial_event", serial_event);
  Bridge.provide("led_frame", led_frame);

  matrix.begin();
  matrix.setGrayscaleBits(1);  // frame values are 0/1
  memset(frame, 0, sizeof frame);
  matrix.draw(frame);

  Modulino.begin(Wire1);  // UNO Q Qwiic connector is on Wire1
  thermoOk = thermo.begin();
  Monitor.println(thermoOk ? "Modulino Thermo found" : "no Modulino Thermo: speed of sound defaults to 343 m/s");
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
    Bridge.notify("trigger_pin", triggerState);  // periodic resend; Python logs changes only
    triggerSentAt = now;
  }

  // Direction arrow from Python.
  if (hasFrame) {
    hasFrame = false;
    String bits = pendingFrame;
    for (int i = 0; i < MATRIX_PIXELS; i++) {
      frame[i] = (i < (int)bits.length() && bits[i] == '1') ? 1 : 0;  // "" -> all off
    }
    matrix.draw(frame);
  }

  // Temperature / humidity for the speed of sound.
  if (thermoOk && now - climateAt >= CLIMATE_PERIOD_MS) {
    climateAt = now;
    float t = thermo.getTemperature();
    float h = thermo.getHumidity();
    if (!isnan(t) && !isnan(h)) {
      Bridge.notify("climate", t, h);
    }
  }

  if (hasEvent) {
    hasEvent = false;
    Monitor.print("SoC: ");
    Monitor.println(lastLine);
    digitalWrite(LED_BUILTIN, HIGH);  // flash on every event summary (non-blocking)
    ledOffAt = now + LED_FLASH_MS;
  }
  if (ledOffAt && (long)(now - ledOffAt) >= 0) {
    digitalWrite(LED_BUILTIN, LOW);
    ledOffAt = 0;
  }
}
