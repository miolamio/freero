// The worker thread rasterJob.ts starts: draws one SVG at a time with raster.ts (resvg's render and
// the PNG / PDF encoding are synchronous and take seconds on a big board) and posts the bytes back.
import { parentPort } from 'node:worker_threads';
import { pdfOf, rasterize } from './raster';
import type { RasterJob } from './rasterJob';

parentPort!.on('message', async (m: { id: number; job: RasterJob }) => {
  try {
    const r = await rasterize(m.job.svg, m.job.scale);
    const { pdf } = m.job;
    const body = pdf ? pdfOf(r.pixels, r.width, r.height, pdf.pageW, pdf.pageH, pdf.title) : r.png;
    // Handed over, not copied — unless the bytes share an ArrayBuffer with others (Buffer's pool).
    const own = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength;
    parentPort!.postMessage({ id: m.id, body, width: r.width, height: r.height }, own ? [body.buffer as ArrayBuffer] : []);
  } catch (e) {
    parentPort!.postMessage({ id: m.id, error: e instanceof Error ? e.message : String(e) });
  }
});
