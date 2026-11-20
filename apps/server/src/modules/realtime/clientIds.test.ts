// A socket may only write under Yjs client ids that are its own: a commenter who knows an editor's
// client id (awareness) and clock (sync step 1) must not be able to burn that clock, which would make
// the server skip the editor's next real update while the editor's client believes it was saved.
// Real y-websocket clients over real sockets against an in-memory Postgres.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { WebsocketProvider } from 'y-websocket';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { WS_MESSAGE_ROLE } from '@freero/shared';
import { closeTestDb, openTestDb } from '../../platform/testing';
import { createUser } from '../auth/index';
import { createBoard } from '../boards/index';
import { admitSocket, snapshotBoardDoc } from './rooms';

let wss: WebSocketServer;
let url: string;
const people = { editor: '', commenter: '' };
const roles = { editor: 'editor', commenter: 'commenter' } as const;
const providers: WebsocketProvider[] = [];

const waitFor = async (cond: () => boolean | Promise<boolean>, what: string, ms = 3000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function connect(boardId: string, who: keyof typeof people) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(`${url}/${who}`, boardId, doc, { WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket, disableBc: true });
  provider.messageHandlers[WS_MESSAGE_ROLE] = () => {};
  providers.push(provider);
  return { doc, provider };
}

beforeAll(async () => {
  await openTestDb();
  people.editor = (await createUser({ name: 'Eddie', email: 'eddie@clientids.test.freero.app', password: 'password-123' })).id;
  people.commenter = (await createUser({ name: 'Dan', email: 'dan@clientids.test.freero.app', password: 'password-123' })).id;
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  wss.on('connection', (ws, req) => {
    const [, who, boardId] = (req.url ?? '').split('/') as [string, keyof typeof people, string];
    void admitSocket(ws, `session-${who}`, async () => ({
      boardId,
      userId: people[who],
      role: roles[who],
      sessionKey: `session-${who}`,
      identity: { id: people[who], name: who, color: '#1C7ED6', avatarUrl: null },
    }));
  });
  await new Promise((r) => wss.once('listening', r));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const p of providers) p.destroy();
  await new Promise((r) => wss.close(r));
  await new Promise((r) => setTimeout(r, 200));
  await closeTestDb();
});

it('a commenter cannot write under an editor’s client id to make the server skip what the editor wrote meanwhile', async () => {
  const board = await createBoard(people.editor, 'Poison', '');
  const editor = connect(board.id, 'editor');
  const commenter = connect(board.id, 'commenter');
  editor.provider.awareness.setLocalStateField('cursor', { x: 1, y: 1 }); // presence: how others learn its client id
  commenter.provider.awareness.setLocalStateField('cursor', { x: 2, y: 2 });
  await waitFor(() => editor.provider.synced && commenter.provider.synced, 'both to sync');
  await waitFor(() => commenter.provider.awareness.getStates().has(editor.doc.clientID), 'the commenter to see the editor’s presence');

  editor.doc.getMap('elements').set('e1', { id: 'e1', type: 'sticky', text: 'first' });
  await waitFor(() => commenter.doc.getMap('elements').has('e1'), 'the first edit to reach the commenter');

  // The editor loses its connection and keeps working: its next change takes the clock the server expects next.
  editor.provider.disconnect();
  await waitFor(() => !editor.provider.wsconnected, 'the editor to go offline');
  editor.doc.getMap('elements').set('e2', { id: 'e2', type: 'sticky', text: 'second' });

  // The commenter's own thread (a write it may make), but stamped with the editor's client id at the editor's next clock.
  const forged = new Y.Doc();
  Y.applyUpdate(forged, Y.encodeStateAsUpdate(commenter.doc));
  const known = Y.encodeStateVector(forged);
  forged.clientID = editor.doc.clientID;
  forged.getMap('comments').set('t:t1', { kind: 'thread', id: 't1', x: 0, y: 0, elementId: null, corner: null, createdAt: 1, createdBy: people.commenter });
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 0); // MESSAGE_SYNC
  syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(forged, known));
  commenter.provider.ws!.send(encoding.toUint8Array(e));
  await new Promise((r) => setTimeout(r, 100));

  editor.provider.connect();
  await waitFor(async () => {
    const d = new Y.Doc();
    const state = await snapshotBoardDoc(board.id);
    if (state) Y.applyUpdate(d, state);
    return d.getMap('elements').has('e2');
  }, 'the editor’s offline edit on the server');
});
