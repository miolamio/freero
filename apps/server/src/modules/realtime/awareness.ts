// Presence (Yjs awareness) arriving from a socket is checked before the room applies it.
// The y-protocols awareness format lets any client write ANY client id's state, so without this
// a crafted client could show up as another person (their id, name and color on its cursor,
// "following" or "presenting" as them) or wipe other people's presence.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

export interface AwarenessIdentity {
  id: string;
  name: string;
  color: string;
  avatarUrl: string | null;
}

/** Client ids one socket may announce (a tab has one; a few more cover id changes after a clash). */
export const MAX_AWARENESS_IDS_PER_SOCKET = 8;
/**
 * One state, as JSON: a cursor, viewport and name are a few hundred bytes; the selection is the
 * big part (a select-all of 10k items is ~200 KB, 100k is ~2 MB). Capped like the largest message a
 * socket without edit rights may send (rooms.ts), so a real selection on a big board still shows;
 * bigger states are not applied, they would be sent to every socket of every instance.
 */
export const MAX_AWARENESS_STATE_CHARS = 2 * 1024 * 1024;

export interface AwarenessContext {
  /** The authenticated user behind the socket; stamped onto every state it publishes. */
  user: AwarenessIdentity;
  /** True when `clientId` is announced over ANOTHER socket of the room (not ours to write). */
  ownedElsewhere(clientId: number): boolean;
  /** False when `clientId` is new to the socket and it already holds its share (`newInUpdate`: new ids taken earlier in this update). */
  mayAnnounce?(clientId: number, newInUpdate: number): boolean;
}

/**
 * Returns the update with every entry the socket may not write removed, and each remaining state's
 * `user` replaced by the authenticated identity (null = nothing left to apply). Throws on a
 * malformed update.
 */
export function sanitizeAwarenessUpdate(update: Uint8Array, ctx: AwarenessContext): Uint8Array | null {
  const decoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(decoder);
  if (len > MAX_AWARENESS_IDS_PER_SOCKET) throw new Error('awareness update with too many entries');
  const kept: Array<{ clientId: number; clock: number; state: string }> = [];
  let announced = 0;
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const raw = decoding.readVarString(decoder);
    if (ctx.ownedElsewhere(clientId)) continue;
    if (raw.length > MAX_AWARENESS_STATE_CHARS) continue;
    if (raw !== 'null' && ctx.mayAnnounce) {
      if (!ctx.mayAnnounce(clientId, announced)) continue;
      announced++;
    }
    const state: unknown = JSON.parse(raw);
    if (state === null) {
      kept.push({ clientId, clock, state: 'null' });
      continue;
    }
    if (typeof state !== 'object' || Array.isArray(state)) continue;
    const s = state as Record<string, unknown>;
    // Presence without a user (e.g. a client that has not set it yet) carries no identity to fake.
    if (s.user !== undefined) s.user = { ...ctx.user };
    // Only the server speaks for an app acting for someone (agent presence, KAI-168).
    delete s.agent;
    kept.push({ clientId, clock, state: JSON.stringify(s) });
  }
  return encodeEntries(kept);
}

/**
 * Presence from ANOTHER instance (already sanitized there), minus the entries for client ids a
 * socket of this instance owns: a client that moved here before the old instance noticed it left
 * must not have its presence removed or overwritten by that instance. Null = nothing left.
 */
export function withoutClients(update: Uint8Array, ownedHere: (clientId: number) => boolean): Uint8Array | null {
  const decoder = decoding.createDecoder(update);
  const len = decoding.readVarUint(decoder);
  const kept: Array<{ clientId: number; clock: number; state: string }> = [];
  for (let i = 0; i < len; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = decoding.readVarString(decoder);
    if (!ownedHere(clientId)) kept.push({ clientId, clock, state });
  }
  return kept.length === len && len > 0 ? update : encodeEntries(kept);
}

function encodeEntries(kept: Array<{ clientId: number; clock: number; state: string }>): Uint8Array | null {
  if (!kept.length) return null;
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, kept.length);
  for (const k of kept) {
    encoding.writeVarUint(e, k.clientId);
    encoding.writeVarUint(e, k.clock);
    encoding.writeVarString(e, k.state);
  }
  return encoding.toUint8Array(e);
}
