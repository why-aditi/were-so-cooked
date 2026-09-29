/**
 * PNG synthesis using nothing but platform APIs.
 *
 * ponytail: no image fixture is checked in and no dependency is added. A PNG is
 * a length-prefixed chunk format wrapped around a zlib stream, and Workers ship
 * CompressionStream('deflate'), which emits exactly the zlib framing PNG wants.
 * Greyscale keeps the raw bitmap small enough to build inside a Worker.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  void writer.write(raw);
  void writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/** An 8-bit greyscale PNG of `size` x `size` carrying a receipt-ish pattern. */
export async function makePng(size: number): Promise<Uint8Array> {
  const raw = new Uint8Array(size * (size + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size + 1);
    raw[rowStart] = 0; // filter type: none
    for (let x = 0; x < size; x += 1) {
      // Horizontal dark bands over a gradient: neither a solid colour (which
      // would compress to nothing) nor noise (which would not compress at all).
      const band = y % 24 < 3 ? 40 : 235;
      raw[rowStart + 1 + x] = Math.min(255, (band + ((x * 3 + y) % 32)) & 0xff);
    }
  }

  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size);
  v.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale

  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}
