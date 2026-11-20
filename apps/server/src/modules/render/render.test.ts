import { expect, it } from 'vitest';
import { chartCellKey, type BoardElement } from '@freero/shared';
import { pixelsOf } from './imageSize';
import { rasterInWorker } from './rasterJob';
import { pictures, RENDER_LIMITS } from './service';
import { boardSvg } from './svg';

const base = { rotation: 0, z: 1, createdBy: 'u', createdAt: 1, updatedAt: 1 };

it('a server export draws a chart from its cells and a team sticker as its picture, not as labelled boxes', () => {
  const chart = { ...base, id: 'c1', type: 'chart', x: 0, y: 0, w: 400, h: 300, kind: 'bar', title: 'Votes', rows: [{ id: 'r1' }, { id: 'r2' }], series: [{ id: 's1' }] } as BoardElement;
  const sticker = { ...base, id: 'e1', type: 'emoji', x: 500, y: 0, w: 64, h: 64, emoji: 'img:/uploads/abcdef12.png', name: 'Wave' } as BoardElement;
  const cells = new Map<string, unknown>([
    [chartCellKey('c1', 'r1', '_'), 'Alpha'],
    [chartCellKey('c1', 'r2', '_'), 'Beta'],
    [chartCellKey('c1', 'r1', 's1'), '3'],
    [chartCellKey('c1', 'r2', 's1'), '6'],
  ]);
  const { svg } = boardSvg({
    elements: [chart, sticker],
    collection: (name) => (name === 'chartCells' ? cells : new Map()),
    imageData: (src) => (src === '/uploads/abcdef12.png' ? 'data:image/png;base64,AAAA' : null),
  });
  // Two bars, Beta's twice as tall as Alpha's, under their labels.
  const bars = [...svg.matchAll(/<rect x="[\d.]+" y="[\d.]+" width="[\d.]+" height="([\d.]+)" rx="[\d.]+" fill="#5B3FF0"\/>/g)].map((m) => Number(m[1]));
  expect(bars).toHaveLength(2);
  expect(bars[1] / bars[0]).toBeCloseTo(2, 1);
  expect(svg).toContain('>Alpha</text>');
  expect(svg).toContain('href="data:image/png;base64,AAAA"');
});

it('an icon is exported with nothing that could run or load, even when its drawing was written straight into the element (#4)', () => {
  const icon = (nodes: unknown, extra: Record<string, unknown> = {}) =>
    ({ ...base, id: 'i1', type: 'icon', x: 0, y: 0, w: 96, h: 96, name: 'x', nodes, color: '#1f1a33', strokeWidth: 2, ...extra }) as BoardElement;
  const crafted = [
    ['path', { d: 'M4 4h16', onload: 'alert(1)', fill: 'url(https://evil.test/x)', style: 'fill:red', href: 'https://evil.test' }],
    ['script', { href: 'https://evil.test/x.js' }],
    ['foreignObject', { width: 24, height: 24 }],
    ['rect', { x: 0, y: 0, width: 10, height: 10, transform: 'translate(1 1)"/><script>alert(2)</script>' }],
    ['circle', { cx: 12, cy: 12, r: 4, fill: '#ff9900' }],
  ];
  for (const el of [icon(crafted), icon(crafted, { art: 'color', viewBox: '0 0 24 24" onload="alert(3)' })]) {
    const { svg } = boardSvg({ elements: [el], collection: () => new Map(), imageData: () => null });
    expect(svg).toContain('<path d="M4 4h16"');
    expect(svg).toContain('fill="#ff9900"');
    expect(svg).not.toMatch(/script|alert|onload|href|url\(|foreignObject|style=/i);
  }
});

it('a picture that claims a huge size in its header is recognised without being decoded, whatever its format and however small the file (resvg would decode it all)', () => {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'latin1');
  png.writeUInt32BE(40000, 16);
  png.writeUInt32BE(30000, 20);
  expect(pixelsOf(png)).toBe(1_200_000_000);
  // JPEG: the size sits in the start-of-frame segment, after other segments (EXIF, tables).
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x06, 1, 2, 3, 4, 0xff, 0xc0, 0x00, 0x0b, 8]), Buffer.alloc(8)]);
  jpeg.writeUInt16BE(20000, 15);
  jpeg.writeUInt16BE(10000, 17);
  expect(pixelsOf(jpeg)).toBe(200_000_000);
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBP', 8, 'latin1');
  webp.write('VP8X', 12, 'latin1');
  webp.writeUIntLE(16383, 24, 3);
  webp.writeUIntLE(16383, 27, 3);
  expect(pixelsOf(webp)).toBe(16384 * 16384);
  // Not an image it can size: null, which the caller treats as over budget.
  expect(pixelsOf(Buffer.from('GIF8'))).toBeNull();
  expect(pixelsOf(Buffer.from('<svg/>'))).toBeNull();
});

it('a PNG and a PDF are drawn on a worker thread, a drawing that fails rejects only its own export, and the next one still works', async () => {
  const svg = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">${inner}</svg>`;
  const png = await rasterInWorker({ svg: svg('<rect width="10" height="10" fill="#5B3FF0"/>'), scale: 2 });
  expect([png.width, png.height]).toEqual([80, 40]);
  expect(png.body.subarray(1, 4).toString('latin1')).toBe('PNG');
  await expect(rasterInWorker({ svg: 'not an svg', scale: 1 })).rejects.toThrow();
  // A drawing that outlives its timeout stops its worker; the old worker's late exit must not fail the next export, which runs on a new one.
  const big = '<svg xmlns="http://www.w3.org/2000/svg" width="8000" height="5000"><rect width="9" height="9"/></svg>'; // ~40 Mpx: far longer than 20 ms
  await expect(rasterInWorker({ svg: big, scale: 1 }, 20)).rejects.toThrow(/too long/);
  const after = await rasterInWorker({ svg: svg('<rect width="5" height="5"/>'), scale: 1 });
  expect(after.width).toBe(40);
  await new Promise((r) => setTimeout(r, 300));
  const pdf = await rasterInWorker({ svg: svg(''), scale: 1, pdf: { pageW: 30, pageH: 15, title: 'Board' } });
  expect(pdf.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
});

it('a raster export keeps every picture it can read within the budgets, drops the biggest first, and still draws one whose header it cannot read', async () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return `data:image/png;base64,${b.toString('base64')}`;
  };
  const img = (id: string, src: string) => ({ ...base, id, type: 'image', x: 0, y: 0, w: 10, h: 10, src }) as BoardElement;
  const limits = { each: RENDER_LIMITS.maxImagePixels, total: RENDER_LIMITS.maxBoardImagePixels };
  const photos = Array.from({ length: 6 }, (_, i) => img(`p${i}`, png(7000, 7000 + i))); // ~49 Mpx each, 294 Mpx together
  const bomb = img('bomb', png(40000, 30000));
  const unreadable = img('odd', 'data:image/png;base64,AAAA');
  const kept = await pictures([bomb, ...photos, unreadable], undefined, limits);
  expect(kept.has((bomb as { src: string }).src)).toBe(false);
  expect(kept.has('data:image/png;base64,AAAA')).toBe(true);
  // Five ~49 Mpx pictures fit 250 Mpx; the sixth (the biggest, whatever its place) does not.
  expect([...kept.keys()].filter((k) => k !== 'data:image/png;base64,AAAA')).toHaveLength(5);
  expect(kept.has((photos[5] as { src: string }).src)).toBe(false);
  // An SVG export decodes nothing, so it keeps all of them.
  expect((await pictures([bomb, ...photos])).size).toBe(7);
});
