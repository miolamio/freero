// How many pixels a PNG, JPEG, GIF or WebP decodes to, read from its header alone (no decoding):
// resvg decodes whatever an <image> holds with no limit of its own, and a few hundred KB of
// compressed zeros can claim a billion pixels. null when the header is not one of those formats
// or is cut short — the caller treats that as "too big to trust".

/** [width, height] of the image in `b`, or null. */
function dimensions(b: Buffer): [number, number] | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b.length >= 10 && b.toString('latin1', 0, 4) === 'GIF8') return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8 ') return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if (kind === 'VP8X') return [1 + b.readUIntLE(24, 3), 1 + b.readUIntLE(27, 3)];
    return null;
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // Walk the segments to the first start-of-frame marker (it holds the size).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1];
      if (marker === 0xff) i++;
      else if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) i += 2;
      else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      else i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return null;
}

export function pixelsOf(bytes: Buffer): number | null {
  const d = dimensions(bytes);
  return d ? d[0] * d[1] : null;
}
