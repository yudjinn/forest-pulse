#pragma once
// USB binary packet format (little-endian, see SPEC.md section 4):
//   [0]  2 B  magic 0xAA 0x55
//   [2]  1 B  msg_type
//   [3]  1 B  flags
//   [4]  4 B  sample_rate
//   [8]  4 B  seq_num
//   [12] 2 B  frame_count N
//   [14] 6N B pcm (int16 [m1, m2, m3] per frame)
//   [14+6N] 4 B CRC32 (IEEE 802.3) over header + pcm

#include <stddef.h>
#include <stdint.h>

#define PKT_MAGIC0 0xAAu
#define PKT_MAGIC1 0x55u

#define PKT_TYPE_PRE 0x01u   // pre-trigger dump
#define PKT_TYPE_LIVE 0x02u  // live continuation
#define PKT_TYPE_END 0x03u   // event end (0 frames)

#define PKT_FLAG_OVERRUN (1u << 0)     // ring overrun: frames skipped before this packet
#define PKT_FLAG_SYNC_LOSS (1u << 1)   // capture lost I2S framing or DMA data: frames dropped

#define PKT_HEADER_BYTES 14u
#define PKT_CRC_BYTES 4u
#define PKT_MAX_BYTES 4096u
#define PKT_MAX_FRAMES ((PKT_MAX_BYTES - PKT_HEADER_BYTES - PKT_CRC_BYTES) / 6u)  // 679

typedef struct __attribute__((packed)) {
    uint8_t magic[2];
    uint8_t msg_type;
    uint8_t flags;
    uint32_t sample_rate;
    uint32_t seq_num;
    uint16_t frame_count;
} pkt_header_t;

_Static_assert(sizeof(pkt_header_t) == PKT_HEADER_BYTES, "header must be 14 bytes");

// The caller has already placed `frames` frames of PCM at pkt + PKT_HEADER_BYTES.
// Writes header and trailing CRC; returns total packet length.
size_t pkt_finalize(uint8_t *pkt, uint8_t type, uint8_t flags, uint32_t sample_rate, uint32_t seq,
                    uint16_t frames);

// True if the ROM CRC32 matches the IEEE check value for "123456789".
int pkt_crc_self_test(void);
