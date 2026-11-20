// A member's private work (drafts, sealed ballots) lives in their private layer, which a room deletes
// when it unloads if the person lost their place on the board. A workspace BLOCK (deactivated, an IP
// allowlist, two-step verification required) is not that: it ends with the block, the work must
// still be there. Real sockets against an in-memory Postgres.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import * as Y from 'yjs';
import type { Account } from '@freero/shared';
import { closeTestDb, openTestDb } from '../../platform/testing';
import { runWithRequestContext } from '../../platform/requestContext';
import { createUser, getAccount } from '../auth/index';
import { createBoard, getBoardAccess } from '../boards/index';
import { inviteBoardMember, removeBoardMember } from '../members/index';
import { createTeamWorkspace, inviteToWorkspace, setMemberDeactivated, updateWorkspaceSettings } from '../workspaces/index';
import { loadLayer } from './layerStore';
import { privateLayerOf } from './layers';
import { admitSocket, initBoardLayer, loadedRoomCount } from './rooms';

const OFFICE = '10.20.30.40';
const CAFE = '203.0.113.9';
const from = <T>(ip: string, fn: () => Promise<T>): Promise<T> => runWithRequestContext({ reqId: `test-${ip}`, userId: null, ip, userAgent: null }, fn);

let wss: WebSocketServer;
let url = '';
let n = 0;
let admit: { userId: string; ip: string } | null = null;

beforeAll(async () => {
  await openTestDb({ FREERO_DOC_IDLE_MS: '100' });
  wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws, req) => {
    const boardId = (req.url ?? '/').slice(1);
    const who = admit!;
    void from(who.ip, () =>
      admitSocket(ws, `s-${who.userId}`, async () => ({
        boardId,
        userId: who.userId,
        role: (await getBoardAccess(boardId, who.userId)).role ?? 'viewer',
        sessionKey: `s-${who.userId}`,
        identity: { id: who.userId, name: 'Someone', color: '#1C7ED6', avatarUrl: null },
      })),
    );
  });
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => wss.close(r));
  await new Promise((r) => setTimeout(r, 300));
  await closeTestDb();
});

const person = (label: string): Promise<Account> =>
  createUser({ name: label, email: `${label.toLowerCase()}-${++n}@blocked.test.freero.app`, password: 'password-123' }, { emailVerified: true });

/** A team board its owner owns and Mia edits, with a draft in Mia's private layer. */
async function boardWithMiasDraft(inTeam = true) {
  const [owner, mia] = await Promise.all([person('Owner'), person('Mia')]);
  const ws = inTeam ? await createTeamWorkspace(owner.id, `Team ${++n}`) : null;
  if (ws) await inviteToWorkspace(null, ws.id, owner, { email: mia.email, role: 'member' });
  const board = await createBoard(owner.id, 'Plans', '', 'none', ws ? { workspaceId: ws.id } : undefined);
  await inviteBoardMember(null, board.id, await getAccount(owner.id), { email: mia.email, role: 'editor' });
  const draft = new Y.Doc();
  draft.getMap('elements').set('d1', { id: 'd1', type: 'sticky', text: 'my unrevealed idea' });
  const layer = privateLayerOf(mia.id);
  await initBoardLayer(board.id, layer, Y.encodeStateAsUpdate(draft));
  return { owner, mia, ws: ws?.id ?? '', board: board.id, layer };
}

/** The owner opens the board and leaves: the room loads Mia's layer and, when idle, unloads it. */
async function ownerVisits(ownerId: string, boardId: string, ip = OFFICE) {
  admit = { userId: ownerId, ip };
  const socket = new WebSocket(`${url}/${boardId}`);
  await new Promise<void>((resolve, reject) => (socket.once('open', () => resolve()), socket.once('error', reject)));
  await new Promise((r) => setTimeout(r, 150));
  socket.close();
  const end = Date.now() + 5000;
  while (loadedRoomCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(loadedRoomCount()).toBe(0);
}

const hasDraft = async (boardId: string, layer: string) => {
  const state = await loadLayer(boardId, layer);
  if (!state) return false;
  const d = new Y.Doc();
  Y.applyUpdate(d, state);
  return d.getMap('elements').has('d1');
};

it('a member’s unrevealed drafts survive their workspace deactivating them while a room unloads', async () => {
  const t = await boardWithMiasDraft();
  await setMemberDeactivated(t.ws, t.owner.id, t.mia.id, true);
  expect((await getBoardAccess(t.board, t.mia.id)).role).toBeNull(); // blocked
  await ownerVisits(t.owner.id, t.board);
  expect(await hasDraft(t.board, t.layer)).toBe(true);
  await setMemberDeactivated(t.ws, t.owner.id, t.mia.id, false);
  expect((await getBoardAccess(t.board, t.mia.id)).role).toBe('editor');
});

it('a member’s drafts survive a room that unloads because of a socket the IP allowlist just closed', async () => {
  const t = await boardWithMiasDraft();
  admit = { userId: t.owner.id, ip: OFFICE };
  const socket = new WebSocket(`${url}/${t.board}`);
  await new Promise<void>((resolve, reject) => (socket.once('open', () => resolve()), socket.once('error', reject)));
  await new Promise((r) => setTimeout(r, 150));
  await from(CAFE, () => updateWorkspaceSettings(t.ws, t.owner.id, { ipAllowlist: ['192.168.0.0/16'], confirmExcludesMe: true }));
  const end = Date.now() + 5000;
  while (loadedRoomCount() > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  expect(loadedRoomCount()).toBe(0);
  expect(await hasDraft(t.board, t.layer)).toBe(true);
});

it('a member removed from the board still has their private layer deleted when the room unloads', async () => {
  const t = await boardWithMiasDraft(false);
  await removeBoardMember(t.board, t.owner.id, t.mia.id);
  expect((await getBoardAccess(t.board, t.mia.id)).role).toBeNull();
  await ownerVisits(t.owner.id, t.board);
  expect(await hasDraft(t.board, t.layer)).toBe(false);
});
