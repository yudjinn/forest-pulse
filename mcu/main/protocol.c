#include "protocol.h"

#include <string.h>

#include "esp_rom_crc.h"

size_t pkt_finalize(uint8_t *pkt, uint8_t type, uint8_t flags, uint32_t sample_rate, uint32_t seq,
                    uint16_t frames)
{
    const pkt_header_t h = {
        .magic = {PKT_MAGIC0, PKT_MAGIC1},
        .msg_type = type,
        .flags = flags,
        .sample_rate = sample_rate,
        .seq_num = seq,
        .frame_count = frames,
    };
    memcpy(pkt, &h, sizeof h);  // Xtensa is little-endian: struct layout == wire layout
    const size_t body = PKT_HEADER_BYTES + (size_t)frames * 6u;
    const uint32_t crc = esp_rom_crc32_le(0, pkt, body);
    memcpy(pkt + body, &crc, sizeof crc);
    return body + PKT_CRC_BYTES;
}

int pkt_crc_self_test(void)
{
    static const uint8_t vec[] = "123456789";
    return esp_rom_crc32_le(0, vec, 9) == 0xCBF43926u;
}
