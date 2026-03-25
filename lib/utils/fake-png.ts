/**
 * lib/utils/fake-png.ts
 *
 * Generates a minimal valid PNG image buffer in pure Node.js (no external deps).
 * Used by the TOKEN_CREATION verifier to satisfy image-upload requirements
 * on token launch forms so the transaction can actually fire.
 */

import { deflateSync } from 'zlib';

// ─── CRC-32 ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len       = Buffer.allocUnsafe(4);
  const crcBuf    = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * Returns a Buffer containing a valid 64×64 PNG image.
 * The image is a simple orange-gradient square — visually plausible as a
 * placeholder token logo.
 */
export function generateFakeTokenPng(size = 64): Buffer {
  const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width, height, bit-depth=8, color-type=2 (RGB)
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // RGB
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // Raw scanlines: filter-byte (0 = None) + RGB pixels
  const rowLen = 1 + size * 3;
  const raw    = Buffer.alloc(size * rowLen);
  for (let y = 0; y < size; y++) {
    raw[y * rowLen] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const off  = y * rowLen + 1 + x * 3;
      const grad = Math.round((x / size) * 60);
      raw[off]     = 240;          // R — warm orange
      raw[off + 1] = 120 + grad;   // G — slight gradient
      raw[off + 2] = 40;           // B
    }
  }

  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
