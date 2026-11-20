// A slow device store (IndexedDB open hung for seconds) must not keep the board from connecting,
// and must not cost the person what it holds: a copy that arrives late is still merged and kept.
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { OfflineCopy } from '../api';
import { BoardStore, type StorePersistence } from './BoardStore';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('a device copy that loads after the board connected is still merged and saved, and the board did not wait for it', async () => {
  vi.useFakeTimers();
  const opened: string[] = [];
  class Socket {
    static readonly OPEN = 1;
    readonly OPEN = 1;
    readyState = 0;
    binaryType = 'arraybuffer';
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor(url: string) {
      opened.push(url);
    }
    send() {}
    close() {}
  }
  vi.stubGlobal('WebSocket', Socket);

  // The copy holds an offline edit that never reached the server.
  const saved = new Y.Doc();
  saved.getMap('elements').set('offline-note', { id: 'offline-note' });
  const copy: OfflineCopy = { shared: Y.encodeStateAsUpdate(saved) };
  let arrive: (c: OfflineCopy) => void = () => {};
  const save = vi.fn(async (_c: OfflineCopy) => {});
  const persist: StorePersistence = { load: () => new Promise((r) => (arrive = r)), save, forget: async () => {}, keeps: () => true };
  const store = new BoardStore({ boardId: 'b1', syncUrl: 'ws://freero.test/ws/boards', persist });
  try {
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(opened.length).toBe(1); // connected without the copy
    arrive(copy);
    await vi.advanceTimersByTimeAsync(5000);
    expect(store.getElement('offline-note')).toBeTruthy();
    expect(save).toHaveBeenCalled();
    expect(opened.length).toBe(1);
  } finally {
    store.destroy();
  }
});
