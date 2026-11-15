// MCU (STM32) side of the Uno Q node.
//
// 1. (No ESP32 wire: Python learns about events from the USB packet stream.)
// 2. Shows the direction arrow Python renders: Bridge "led_frame" delivers a
//    104-char '0'/'1' string (8 rows x 13 columns, row-major); "" clears.
// 3. Reads the Modulino Thermo (Qwiic) every 5 s and reports
//    Bridge.notify("climate", temp_c, rh_percent) for the speed of sound.
//    Without a Modulino, Python falls back to 343 m/s.
// 4. Receives one-line event summaries (Bridge "serial_event", Monitor only).
// 6. Status LED (LED3, RGB, active-low), highest priority first:
//      red solid          ESP32 not connected/answering, or Python silent > 10 s
//      blue solid         event being recorded (from Python: the packet stream)
//      yellow slow blink  no server connection (1 s on / 1 s off)
//      green solid        all good
//    Python reports Bridge.notify("node_status", esp_ok, server_ok, recording) on every
//    change and at least every 2 s.
// 5. Location calibration: Bridge "emit"(f_start, f_mid, f_end, duration_ms)
//    plays a stepped sweep on the Modulino Buzzer (f_start -> f_mid -> f_end,
//    1 ms steps) and answers Bridge.notify("emit_done", 1/0). The start time
//    doesn't matter (it cancels in two-way ranging); the shape must repeat.
//    See LocationCalibrationIntegrationSpec.md.
//
// Callbacks only store data; the work happens in loop(), and loop() never
// blocks.

#include <Arduino_LED_Matrix.h>
#include <Arduino_Modulino.h>
#include <Arduino_RouterBridge.h>

const unsigned long STATUS_STALE_MS = 10000;  // no node_status for this long -> Python is down -> red
const unsigned long BLINK_HALF_MS = 1000;      // yellow slow blink: 1 s on, 1 s off
const unsigned long CLIMATE_PERIOD_MS = 5000;
const int MATRIX_PIXELS = 8 * 13;

Arduino_LED_Matrix matrix;
ModulinoThermo thermo;
bool thermoOk = false;
ModulinoBuzzer buzzer;
bool buzzerOk = false;
const unsigned long SWEEP_STEP_US = 1000;
const unsigned long MODULINO_STATUS_MS = 5000;  // report + retry missing modules (hot-plug, late Python)
unsigned long modulinoAt = 0;
String i2cFound;  // addresses seen on the Qwiic bus (Wire1), e.g. "0x1e 0x44"

void scanQwiic() {
  i2cFound = "";
  for (uint8_t a = 1; a < 127; a++) {
    Wire1.beginTransmission(a);
    if (Wire1.endTransmission() == 0) {
      char b[6];
      snprintf(b, sizeof b, "0x%02x", a);
      if (i2cFound.length()) i2cFound += " ";
      i2cFound += b;
    }
  }
  if (!i2cFound.length()) i2cFound = "none";
}

// Direct SHT3x reader (newer Modulino Thermo boards: SHT3x at 0x45), used when
// the library's begin() fails. Single shot, high repeatability, no clock stretching.
const uint8_t SHT3X_ADDR = 0x45;
bool shtRaw = false;   // thermo is read with readSht3x() instead of the library
String thermoDiag;     // why the thermo isn't working (reported to Python)

uint8_t sht3xCrc(const uint8_t *d) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < 2; i++) {
    crc ^= d[i];
    for (int b = 0; b < 8; b++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

// 0 = ok; otherwise 10 + endTransmission() code, 20 = short read, 30 = CRC error
int readSht3x(float &t, float &rh) {
  Wire1.beginTransmission(SHT3X_ADDR);
  Wire1.write(0x24);
  Wire1.write(0x00);
  int e = Wire1.endTransmission();
  if (e != 0) return 10 + e;
  delay(16);
  uint8_t d[6];
  int n = Wire1.requestFrom(SHT3X_ADDR, (uint8_t)6);
  for (int i = 0; i < 6 && Wire1.available(); i++) d[i] = Wire1.read();
  if (n != 6) return 20;
  if (sht3xCrc(d) != d[2] || sht3xCrc(d + 3) != d[5]) return 30;
  t = -45.0f + 175.0f * (float)((d[0] << 8) | d[1]) / 65535.0f;
  rh = 100.0f * (float)((d[3] << 8) | d[4]) / 65535.0f;
  return 0;
}

void checkModulinos() {
  if (!thermoOk && !shtRaw) {
    thermoOk = thermo.begin();
  thermoDiag = thermoOk ? "library" : "";
    if (!thermoOk) {
      float t, h;
      int e = readSht3x(t, h);
      shtRaw = (e == 0);
      thermoDiag = shtRaw ? "library begin() failed; direct SHT3x read works"
                          : "library begin() failed; direct SHT3x read error " + String(e);
    } else {
      thermoDiag = "library";
    }
  }
  if (!buzzerOk) buzzerOk = buzzer.begin();
  scanQwiic();
  Bridge.notify("modulino_status", (thermoOk || shtRaw) ? 1 : 0, buzzerOk ? 1 : 0, i2cFound + " | thermo: " + thermoDiag);
}

volatile bool hasEmit = false;
int emitArgs[4];  // f_start, f_mid, f_end (Hz), duration (ms)

volatile bool hasEvent = false;
String lastLine;
volatile bool hasFrame = false;
String pendingFrame;
uint8_t frame[MATRIX_PIXELS];

volatile bool espOk = false, serverOk = false, recording = false;
volatile unsigned long statusAt = 0;  // millis() of the last node_status (0 = never)
bool statusSeen = false;
int ledColor = -1;  // last colour written (bits: 1 red, 2 green, 4 blue), -1 = none yet
unsigned long climateAt = 0;

void serial_event(String line) {
  lastLine = line;
  hasEvent = true;
}

void node_status(int esp, int server, int rec) {
  espOk = esp != 0;
  serverOk = server != 0;
  recording = rec != 0;
  statusAt = millis();
  statusSeen = true;
}

// LED3 is common-anode: LOW lights a colour.
void setLed(int color) {
  if (color == ledColor) return;
  ledColor = color;
  digitalWrite(LED3_R, (color & 1) ? LOW : HIGH);
  digitalWrite(LED3_G, (color & 2) ? LOW : HIGH);
  digitalWrite(LED3_B, (color & 4) ? LOW : HIGH);
}

void updateStatusLed(unsigned long now) {
  const int RED = 1, GREEN = 2, BLUE = 4, YELLOW = RED | GREEN, OFF = 0;
  // signed: a callback can land just after `now` was read
  bool pythonAlive = statusSeen && (long)(now - statusAt) < (long)STATUS_STALE_MS;
  if (!pythonAlive || !espOk) {
    setLed(RED);
  } else if (recording) {
    setLed(BLUE);
  } else if (!serverOk) {
    setLed((now / BLINK_HALF_MS) % 2 ? YELLOW : OFF);
  } else {
    setLed(GREEN);
  }
}

void led_frame(String bits) {
  pendingFrame = bits;
  hasFrame = true;
}

void emit(int fStart, int fMid, int fEnd, int durationMs) {
  emitArgs[0] = fStart;
  emitArgs[1] = fMid;
  emitArgs[2] = fEnd;
  emitArgs[3] = durationMs;
  hasEmit = true;
}

// Piecewise-linear stepped sweep. Blocks loop() for the sweep's duration
// (tens of ms); each tone() lasts a little longer than a step so there are no
// gaps between I2C writes, and noTone() ends it cleanly.
void playSweep(int fStart, int fMid, int fEnd, int durationMs) {
  unsigned long steps = (unsigned long)durationMs * 1000UL / SWEEP_STEP_US;
  if (steps < 2) steps = 2;
  unsigned long half = steps / 2;
  unsigned long t0 = micros();
  for (unsigned long i = 0; i < steps; i++) {
    float f = i < half ? fStart + (fMid - fStart) * (float)i / half
                       : fMid + (fEnd - fMid) * (float)(i - half) / (steps - 1 - half > 0 ? steps - 1 - half : 1);
    buzzer.tone((size_t)f, 3);
    while (micros() - t0 < (i + 1) * SWEEP_STEP_US) {
    }
  }
  buzzer.noTone();
}

void setup() {
  pinMode(LED3_R, OUTPUT);
  pinMode(LED3_G, OUTPUT);
  pinMode(LED3_B, OUTPUT);
  setLed(1);  // red until Python reports the ESP32 and server
  Bridge.begin();
  Monitor.begin();
  Bridge.provide("serial_event", serial_event);
  Bridge.provide("led_frame", led_frame);
  Bridge.provide("node_status", node_status);
  Bridge.provide("emit", emit);

  matrix.begin();
  matrix.setGrayscaleBits(1);  // frame values are 0/1
  memset(frame, 0, sizeof frame);
  matrix.draw(frame);

  Modulino.begin(Wire1);  // UNO Q Qwiic connector is on Wire1
  thermoOk = thermo.begin();
  Monitor.println(thermoOk ? "Modulino Thermo found" : "no Modulino Thermo: speed of sound defaults to 343 m/s");
  buzzerOk = buzzer.begin();
  Monitor.println(buzzerOk ? "Modulino Buzzer found" : "no Modulino Buzzer: calibration emit disabled");
  checkModulinos();
  modulinoAt = millis();
}

void loop() {
  unsigned long now = millis();

  // Direction arrow from Python.
  if (hasFrame) {
    hasFrame = false;
    String bits = pendingFrame;
    for (int i = 0; i < MATRIX_PIXELS; i++) {
      frame[i] = (i < (int)bits.length() && bits[i] == '1') ? 1 : 0;  // "" -> all off
    }
    matrix.draw(frame);
  }

  // Modulino presence: report every 5 s (Python logs changes) and retry missing ones.
  if (now - modulinoAt >= MODULINO_STATUS_MS) {
    modulinoAt = now;
    checkModulinos();
  }

  // Temperature / humidity for the speed of sound.
  if ((thermoOk || shtRaw) && now - climateAt >= CLIMATE_PERIOD_MS) {
    climateAt = now;
    float t = NAN, h = NAN;
    if (shtRaw) {
      int e = readSht3x(t, h);
      if (e != 0) {
        Monitor.print("SHT3x read error ");
        Monitor.println(e);
        t = h = NAN;
      }
    } else {
      t = thermo.getTemperature();
      h = thermo.getHumidity();
    }
    if (!isnan(t) && !isnan(h)) {
      Bridge.notify("climate", t, h);
    }
  }

  // Location calibration sweep.
  if (hasEmit) {
    hasEmit = false;
    if (buzzerOk) {
      playSweep(emitArgs[0], emitArgs[1], emitArgs[2], emitArgs[3]);
    }
    Bridge.notify("emit_done", buzzerOk ? 1 : 0);
  }

  if (hasEvent) {
    hasEvent = false;
    Monitor.print("SoC: ");
    Monitor.println(lastLine);
  }

  updateStatusLed(now);
}
