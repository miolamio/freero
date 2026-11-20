// SVG → PNG / PDF on a worker thread, so a big export (seconds of synchronous drawing and encoding in
// resvg) never stops the server's event loop. One worker, started on first use and kept warm (it
// holds the WASM module and the fonts): exports run one at a time, in the order they came, the
// rest waiting in its message queue. If it dies (a WASM trap, out of memory) the jobs it held fail
// and the next export starts a fresh one.
//
// The worker file is TypeScript like the rest of the server (which is never bundled): it runs
// under tsx, started explicitly so it works the same under `node --import tsx`, `tsx watch` and tests.
import { Worker } from 'node:worker_threads';

export interface RasterJob {
  svg: string;
  scale: number;
  /** Wrap the picture in a one-page PDF of this size (points) instead of returning the PNG. */
  pdf?: { pageW: number; pageH: number; title: string };
}

interface Reply {
  id: number;
  body?: Uint8Array;
  width?: number;
  height?: number;
  error?: string;
}

/** A job that takes longer than this is a hung drawing (a 40 Mpx board with 250 Mpx of pictures takes ~5 s): its worker is stopped. */
const JOB_TIMEOUT_MS = 60_000;

interface Held {
  resolve: (r: { body: Buffer; width: number; height: number }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
/** The worker, and the jobs posted to it (a dead worker only ever fails its own). */
let current: { w: Worker; pending: Map<number, Held> } | null = null;
let nextId = 0;

function start() {
  const w = new Worker(new URL('./raster.worker.ts', import.meta.url), { execArgv: ['--import', 'tsx'] });
  const me = { w, pending: new Map<number, Held>() };
  w.on('message', (m: Reply) => {
    const job = me.pending.get(m.id);
    if (!job) return;
    me.pending.delete(m.id);
    clearTimeout(job.timer);
    if (m.body) job.resolve({ body: Buffer.from(m.body.buffer, m.body.byteOffset, m.body.byteLength), width: m.width ?? 0, height: m.height ?? 0 });
    else job.reject(new Error(m.error ?? 'The picture could not be drawn'));
  });
  const gone = (e: Error) => {
    if (current === me) current = null;
    for (const job of me.pending.values()) {
      clearTimeout(job.timer);
      job.reject(e);
    }
    me.pending.clear();
  };
  w.on('error', gone);
  w.on('exit', (code) => gone(new Error(`The picture worker stopped (exit ${code})`)));
  w.unref(); // after the listeners (adding one re-refs the port): an idle worker never keeps the process from exiting
  return me;
}

export function rasterInWorker(job: RasterJob, timeoutMs = JOB_TIMEOUT_MS): Promise<{ body: Buffer; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const me = (current ??= start());
    const id = nextId++;
    // A hung drawing can't be interrupted from inside: stop the worker (its other jobs fail with it).
    const timer = setTimeout(() => {
      reject(new Error('The picture took too long to draw'));
      me.pending.delete(id);
      if (current === me) current = null;
      for (const held of me.pending.values()) {
        clearTimeout(held.timer);
        held.reject(new Error('The picture worker was stopped'));
      }
      me.pending.clear();
      void me.w.terminate();
    }, timeoutMs);
    me.pending.set(id, { resolve, reject, timer });
    me.w.postMessage({ id, job });
  });
}
