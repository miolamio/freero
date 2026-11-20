// Per-socket limits: what a commenter or a mere reader of a shared link can make the server
// do. Raw WebSocket clients against an in-memory Postgres, so the frames are exactly what a hostile
// client would send.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import { closeTestDb, openTestDb } from '../../platform/testing';
import { createUser } from '../auth/index';
import { createBoard } from '../boards/index';
import { MAX_AWARENESS_STATE_CHARS, sanitizeAwarenessUpdate } from './awareness';
import { admitSocket, snapshotBoardDoc } from './rooms';

let wss: WebSocketServer;
let url: string;
let userId = '';
const sockets: WebSocket[] = [];

const waitFor = async (cond: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

beforeAll(async () => {
  await openTestDb();
  userId = (await createUser({ name: 'Dan', email: 'dan@limits.test.freero.app', password: 'password-123' })).id;
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const [, role, boardId] = (req.url ?? '').split('/') as [string, 'commenter' | 'viewer', string];
    void admitSocket(ws, 'session', async () => ({ boardId, userId, role, sessionKey: 'session', identity: { id: userId, name: 'Dan', color: '#1C7ED6', avatarUrl: null } }));
  });
  await new Promise((r) => wss.once('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const s of sockets) s.terminate();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => setTimeout(r, 200));
  await closeTestDb();
});

/** An open socket that records every message the server sends it, parsed to [type, syncType]. */
async function open(role: 'commenter' | 'viewer', boardId: string) {
  const ws = new WebSocket(`${url}/${role}/${boardId}`);
  sockets.push(ws);
  const got: Array<[number, number]> = [];
  const closed: number[] = [];
  ws.on('message', (data) => {
    const d = decoding.createDecoder(new Uint8Array(data as Buffer));
    const type = decoding.readVarUint(d);
    got.push([type, type === 0 ? decoding.readVarUint(d) : -1]);
  });
  ws.on('close', (code) => closed.push(code));
  await new Promise((r) => ws.once('open', r));
  await waitFor(() => got.some(([t, s]) => t === 0 && s === 0), 'the server’s own sync step 1');
  return { ws, got, closed };
}

const syncMessage = (write: (e: encoding.Encoder) => void) => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0);
  write(e);
  return encoding.toUint8Array(e);
};
const STEP2 = 1;

it('a socket that asks for the whole board over and over is answered only a few times', async () => {
  const board = await createBoard(userId, 'Amplify', '');
  const { ws, got } = await open('viewer', board.id);
  for (let i = 0; i < 100; i++) ws.send(syncMessage((e) => syncProtocol.writeSyncStep1(e, new Y.Doc())));
  await new Promise((r) => setTimeout(r, 500));
  const answers = got.filter(([t, s]) => t === 0 && s === STEP2).length;
  expect(answers).toBeGreaterThan(0);
  expect(answers).toBeLessThan(30);
});

it('a commenter’s oversized message closes its socket instead of being read', async () => {
  const board = await createBoard(userId, 'Big', '');
  const { ws, closed } = await open('commenter', board.id);
  ws.send(syncMessage((e) => syncProtocol.writeUpdate(e, new Uint8Array(3 * 1024 * 1024))));
  await waitFor(() => closed.length > 0, 'the socket to be closed');
  expect(closed[0]).toBe(1009);
});

it('a commenter sending updates far faster than anyone types gets only part of them applied, and is told by a close its client reconnects on', async () => {
  const board = await createBoard(userId, 'Flood', '');
  const { ws, closed } = await open('commenter', board.id);
  const sent = 300;
  for (let i = 0; i < sent; i++) {
    const d = new Y.Doc();
    d.getMap('comments').set(`t:t${i}`, { kind: 'thread', id: `t${i}`, x: 0, y: 0, elementId: null, corner: null, createdAt: 1, createdBy: userId });
    ws.send(syncMessage((e) => syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(d))));
  }
  await waitFor(() => closed.length > 0, 'the socket to be closed');
  expect(closed[0]).toBe(4429);
  const stored = new Y.Doc();
  Y.applyUpdate(stored, (await snapshotBoardDoc(board.id))!);
  const kept = stored.getMap('comments').size;
  expect(kept).toBeGreaterThan(0);
  expect(kept).toBeLessThan(sent);
});

it('presence with more entries than a socket has tabs, or a state big enough to flood the room, is not passed on', () => {
  const user = { id: 'dan', name: 'Dan', color: '#000', avatarUrl: null };
  const awareness = (states: Array<[number, unknown]>) => {
    const a = new awarenessProtocol.Awareness(new Y.Doc());
    for (const [id, state] of states) {
      a.states.set(id, state as Record<string, unknown>);
      a.meta.set(id, { clock: 5, lastUpdated: 0 });
    }
    return awarenessProtocol.encodeAwarenessUpdate(a, states.map(([id]) => id));
  };
  const ctx = { user, ownedElsewhere: () => false };
  const many = awareness(Array.from({ length: 50 }, (_, i): [number, unknown] => [i + 1, { cursor: null }]));
  expect(() => sanitizeAwarenessUpdate(many, ctx)).toThrow();
  const big = awareness([[1, { selection: ['x'.repeat(MAX_AWARENESS_STATE_CHARS)] }]]);
  expect(sanitizeAwarenessUpdate(big, ctx)).toBeNull();
});
