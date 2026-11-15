#pragma once
// ATech 14-port motherboard pin assignments. ALL board wiring lives here.
//
// Source: atech.dev 14-port pin map (each port's D1/D2 data lines wire
// straight to one ESP32-S3 GPIO) and the microphone module pinout:
//   module 1st port: D1 = LR,  D2 = WS
//   module 2nd port: D1 = SCK, D2 = SD
//   (right edge: 1st port = lower port number; left edge: the reverse)
//
//   port | D1 (line A) | D2 (line B)
//   -----+-------------+------------
//     1  |   GPIO9     |   GPIO8
//     2  |   GPIO5     |   GPIO4
//     9  |   GPIO40    |   GPIO41
//    10  |   GPIO1     |   GPIO2
//    13  |   GPIO39    |   GPIO38
//    14  |   GPIO36    |   GPIO35
//     3  |   GPIO17    |   GPIO18
//     4  |   GPIO16    |   GPIO15
//   (free ports: 5 = 11/10, 6 = 13/12 (13 is the notify line), 7 = 6/7;
//    port 11 = GPIO43/44 is the UART0 console)

#define PIN_UNUSED (-1)

// --- Mic 1: ports 1-2 ------------------------------------------------------
// Left-edge modules sit rotated 180 deg vs the right edge (12V pin always on
// the module's left), so the module's FIRST port (LR/WS) lands on board
// port 2 and its SECOND port (SCK/SD) on board port 1. Verified on hardware.
#define PIN_MIC1_LR 5     // port 2 D1  (driven LOW -> left slot)
#define PIN_MIC1_WS 4     // port 2 D2
#define PIN_MIC1_BCLK 9   // port 1 D1  (SCK)
#define PIN_MIC1_SD 8     // port 1 D2

// --- Mic 2: ports 9-10 -----------------------------------------------------
#define PIN_MIC2_LR 40    // port 9 D1
#define PIN_MIC2_WS 41    // port 9 D2
#define PIN_MIC2_BCLK 1   // port 10 D1
#define PIN_MIC2_SD 2     // port 10 D2

// --- Mic 3: ports 13-14 ----------------------------------------------------
#define PIN_MIC3_LR 39    // port 13 D1
#define PIN_MIC3_WS 38    // port 13 D2
#define PIN_MIC3_BCLK 36  // port 14 D1
#define PIN_MIC3_SD 35    // port 14 D2

// --- Speaker: ports 3-4 (ATech Speaker v2.2, MAX98357A, I2S) ----------------
// UNVERIFIED pinout, assumed to follow the mic module's layout: module 1st port
// D1 = SD_MODE (enable: high = on), D2 = LRC (WS); 2nd port D1 = BCLK, D2 = DIN.
// Left edge, so the module's 1st port lands on board port 4 and its 2nd on 3.
// Check against the module's pin page before trusting the speaker; a wrong map
// only leaves it silent (all four are outputs the module reads).
#define PIN_SPK_EN 16     // port 4 D1
#define PIN_SPK_WS 15     // port 4 D2
#define PIN_SPK_BCLK 17   // port 3 D1
#define PIN_SPK_DIN 18    // port 3 D2

// --- Internal: LCD_CAM VSYNC control pad (port 7 D2, nothing plugged in) ---
// The camera only starts a capture on a VSYNC edge, so VSYNC is routed from a
// pad that firmware toggles once at start-up.
#define PIN_CAM_VSYNC 7

// --- "Data incoming" notify to the Uno Q (HIGH for the duration of an event)
#define PIN_WAKE 13  // port 6 D1 (3.3 V logic)
