// "What changed since the last check?" (2026-11-20). The other tools see only the account as it is now; this one keeps a
// small snapshot of every room (status, health, open issues, devices that are not online) and compares the next check
// with it: rooms that went offline or came back, health that got worse or better, issues opened or closed, devices that
// dropped or recovered, rooms added or removed. Worst first. Read-only toward Zoom; it writes only its own snapshot file.
// Anything not read this time keeps its last good reading and is listed as not compared, never as fixed or cleared.
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

/** A save lock older than this was left by a process that stopped mid-save. */
export const LOCK_STALE_MS = 30_000;
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { roomCount, type ZoomRoomsClient } from "./client.ts";
import { deviceName } from "./device-fields.ts";

/** Rooms read in detail (issues and devices) per check: rooms that look unhappy now or did last time. */
export const DETAIL_LIMIT = 25;
/** Room detail reads run this many at a time. */
export const DETAIL_CONCURRENCY = 5;
/**
 * Room details stop being read this long after the check starts (room list included), so what_changed answers well
 * inside an MCP client's usual 60 s deadline even when Zoom is slow; rooms not read in time are named and keep their
 * last saved reading.
 */
export const DETAIL_BUDGET_MS = 40_000;
/** An empty room list is confirmed only by a second empty read at least this long after the first... */
export const EMPTY_CONFIRM_MIN_MS = 10 * 60_000;
/** ...and no longer than this after it (a week, so a daily check still confirms); an older hold starts again. */
export const EMPTY_CONFIRM_MAX_MS = 7 * 86_400_000;

export interface RoomListFacts {
  name: string;
  status: string;
  health: string;
}
export interface RoomDetailFacts {
  /** Open issue texts, lowercased and sorted. */
  issues: string[];
  /** Devices not online, as "name (type)" -> status. */
  down: Record<string, string>;
  /** Every device listed, as "name (type)", sorted. Missing in readings saved before 2026-11-24. */
  seen?: string[];
  /** False when Zoom's room profile had no issues list (its documented shape): devices were read, issues were not. */
  issuesRead?: boolean;
  /** When the saved issues were last actually read, if earlier than `at` (kept because Zoom gave no issues list since). */
  issuesAt?: string;
  /** Zoom's device id for each device key that has one (saved since 2026-11-27), so a renamed key still finds its device. */
  ids?: Record<string, string>;
  /** Keys that stand for more than one device: same name and type, and Zoom gave no device id to tell them apart. */
  shared?: string[];
}
export interface RoomSnapshot {
  /** `unconfirmed`: first seen in a partial list after a full one, so the next full read still reports it added. */
  list: RoomListFacts & { at: string; unconfirmed?: boolean };
  detail?: RoomDetailFacts & { at: string };
}
export interface Snapshot {
  version: 1;
  /** A one-way fingerprint of the Zoom account, so two accounts are never compared. "demo" for demo data. */
  account: string;
  /** When the whole room list was last read in full. Rooms are called added or removed only between two full reads. */
  fullListAt: string | null;
  /** Set when a clean, complete read found no rooms though there were rooms before; a second such read confirms it. */
  emptyListAt?: string;
  rooms: Record<string, RoomSnapshot>;
}

export interface SnapshotStore {
  load(): Snapshot | null;
  save(s: Snapshot): void;
  /** Runs fn while no other process can save to the same place (file stores); a store in memory just runs it. */
  exclusive?<T>(fn: () => T): T;
  readonly where: string;
}

const isObj = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown) => isStr(v) && !Number.isNaN(Date.parse(v));
const validRoom = (r: unknown): boolean =>
  isObj(r) && isObj(r.list) && isStr(r.list.name) && isStr(r.list.status) && isStr(r.list.health) && isTime(r.list.at) && (r.list.unconfirmed === undefined || typeof r.list.unconfirmed === "boolean") &&
  (r.detail === undefined || (isObj(r.detail) && isTime(r.detail.at) && Array.isArray(r.detail.issues) && r.detail.issues.every(isStr) &&
    isObj(r.detail.down) && Object.values(r.detail.down).every(isStr) &&
    (r.detail.seen === undefined || (Array.isArray(r.detail.seen) && r.detail.seen.every(isStr))) &&
    (r.detail.issuesRead === undefined || typeof r.detail.issuesRead === "boolean") &&
    (r.detail.issuesAt === undefined || isTime(r.detail.issuesAt)) &&
    (r.detail.ids === undefined || (isObj(r.detail.ids) && Object.values(r.detail.ids).every(isStr))) &&
    (r.detail.shared === undefined || (Array.isArray(r.detail.shared) && r.detail.shared.every(isStr)))));
export const isSnapshot = (x: unknown): x is Snapshot =>
  isObj(x) && x.version === 1 && isStr(x.account) && (x.fullListAt === null || isTime(x.fullListAt)) && (x.emptyListAt === undefined || isTime(x.emptyListAt)) && isObj(x.rooms) && Object.values(x.rooms).every(validRoom);

export class MemorySnapshotStore implements SnapshotStore {
  readonly where = "demo memory only (nothing is written to disk)";
  #data: Snapshot | null;
  constructor(initial: Snapshot | null = null) {
    this.#data = initial ? structuredClone(initial) : null;
  }
  load() {
    return this.#data ? structuredClone(this.#data) : null;
  }
  save(s: Snapshot) {
    this.#data = structuredClone(s);
  }
}

/** One file per Zoom account (named by the account fingerprint), so accounts never share a starting point. */
export const defaultSnapshotPath = (account: string, env: NodeJS.ProcessEnv = process.env) => env.ZOOM_ROOMS_STATE || join(homedir(), ".zoom-rooms-mcp", `last-check-${account}.json`);
/** A one-way fingerprint of the account id: enough to tell accounts apart, never the id itself. */
export const accountFingerprint = (accountId: string) => createHash("sha256").update(`zoom-rooms-mcp:${accountId}`).digest("hex").slice(0, 16);

/** One JSON file on this computer, readable only by its owner, replaced atomically. */
export class FileSnapshotStore implements SnapshotStore {
  readonly where: string;
  constructor(where: string) {
    this.where = where;
  }
  load(): Snapshot | null {
    if (!existsSync(this.where)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.where, "utf8"));
    } catch (error) {
      throw new Error(`the saved check at ${this.where} could not be read (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!isSnapshot(parsed)) throw new Error(`the saved check at ${this.where} is not in the expected shape`);
    return parsed;
  }
  save(s: Snapshot) {
    mkdirSync(dirname(this.where), { recursive: true, mode: 0o700 });
    const tmp = `${this.where}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.where);
  }
  /**
   * Runs fn holding a lock file next to the saved check, so two copies of this server (two chats) never check and save
   * at the same time (Codex review, 11/25). A lock left by a crashed process is taken over after LOCK_STALE_MS.
   */
  exclusive<T>(fn: () => T): T {
    mkdirSync(dirname(this.where), { recursive: true, mode: 0o700 });
    const lock = `${this.where}.lock`;
    const mine = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const take = () => {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeFileSync(fd, mine);
      } finally {
        closeSync(fd);
      }
    };
    try {
      take();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) throw new Error("another check is being saved right now");
      // Take over a stale lock by renaming it away (one process wins the rename), never by deleting it, so two
      // processes can never both clear it and both hold the lock (Sonnet review, 11/25).
      try {
        renameSync(lock, `${lock}.stale-${mine}`);
        rmSync(`${lock}.stale-${mine}`, { force: true });
        take();
      } catch {
        throw new Error("another check is being saved right now");
      }
    }
    try {
      return fn();
    } finally {
      // Remove the lock only if it is still ours (a slow save never removes the next holder's lock).
      try {
        if (readFileSync(lock, "utf8") === mine) rmSync(lock, { force: true });
      } catch {
        // already gone
      }
    }
  }
  /** Moves an unreadable file aside (kept, not deleted) so a fresh starting point can be saved. */
  setAside(now: number): string {
    const aside = `${this.where}.unreadable-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
    renameSync(this.where, aside);
    return aside;
  }
}

// ---------- reading the account ----------

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const OK_DEVICE = /^(online|connected|available|in ?use)$/i;
const RESOLVED = /^(resolved|closed|cleared|fixed)$/i;
/** Own entries only, so a room id like "constructor" is never mistaken for a built-in. */
const prevRoom = (s: Snapshot | null | undefined, id: string): RoomSnapshot | undefined => (s && Object.hasOwn(s.rooms, id) ? s.rooms[id] : undefined);
const UP_STATUS = /^(available|online|in ?meeting|idle|connected)$/i;
const issueKey = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
const HEALTH_RANK: Record<string, number> = { healthy: 0, warning: 1, critical: 2 };
const unhappy = (f: RoomListFacts) => /^offline$/i.test(f.status) || /^(warning|critical)$/i.test(f.health) || !(f.health.toLowerCase() in HEALTH_RANK);

export interface Reading {
  rooms: Map<string, RoomListFacts>;
  details: Map<string, RoomDetailFacts>;
  /** True when every page of the room list was read and every row had an id. */
  fullList: boolean;
  couldNotCheck: string[];
  /** Rooms that needed a detail read but were past DETAIL_LIMIT. */
  skippedDetail: string[];
  /** True when a clean, complete read found no rooms though the last check had rooms. */
  emptyList?: boolean;
  /** When the held empty read still waiting for its confirmation started (kept, so the wait is not restarted). */
  emptyHeldAt?: string;
}

const readDetail = async (client: ZoomRoomsClient, id: string): Promise<RoomDetailFacts> => {
  const [room, devices] = await Promise.all([client.getRoom(id), client.getRoomDevices(id)]);
  if (!isObj(room)) throw new Error("the room detail came back in an unexpected shape");
  // No issues list, or an issue in a shape we cannot read, means the issues are unknown, never "none".
  const rawIssues = (room as any).issues;
  // Zoom's documented room profile has no issues list (Codex review, 11/25): the devices are still read and compared;
  // the issues are marked unread, never "none".
  if (rawIssues != null && !Array.isArray(rawIssues)) throw new Error("its open issues came back in an unexpected shape");
  const issuesRead = Array.isArray(rawIssues);
  const rawDevices = isObj(devices) ? (devices as any).devices : Array.isArray(devices) ? devices : undefined;
  if (!Array.isArray(rawDevices)) throw new Error("its device list came back in an unexpected shape");
  // Kept as written; compared ignoring case and spacing.
  const byKey = new Map<string, string>();
  for (const i of issuesRead ? rawIssues : []) {
    // A resolved or closed issue is not open, whatever its text (Codex review, 11/25).
    if (isObj(i) && RESOLVED.test(str(i.status))) continue;
    const text = str(isObj(i) ? i.issue ?? i.message ?? i.description : i).replace(/\s+/g, " ");
    if (!text) throw new Error("an open issue came back in a shape that could not be read");
    if (!byKey.has(issueKey(text))) byKey.set(issueKey(text), text);
  }
  const issues = [...byKey.values()].sort();
  // A device is keyed "name (type)". Two devices with one name and type in the same room (two "Panel" controllers) are
  // told apart by Zoom's device id, so one going offline while the other recovers is still a change (Codex review, 11/24).
  const rows = rawDevices.map((d) => {
    if (!isObj(d)) throw new Error("a device came back in a shape that could not be read");
    const nm = deviceName(d) || "Unnamed device";
    const type = str(d.device_type) || "device";
    return { nm, type, base: `${nm} (${type})`, id: str(d.id) || str(d.device_id), status: str(d.status) };
  });
  const perBase = new Map<string, number>();
  for (const r of rows) perBase.set(r.base, (perBase.get(r.base) ?? 0) + 1);
  const down: Record<string, string> = {};
  const seen = new Set<string>();
  const ids: Record<string, string> = {};
  const shared = new Set<string>();
  for (const r of rows) {
    const key = (perBase.get(r.base) ?? 0) > 1 && r.id ? `${r.nm} (${r.type}, Zoom device ${r.id})` : r.base;
    if (seen.has(key)) shared.add(key);
    seen.add(key);
    if (r.id && !shared.has(key)) ids[key] = r.id;
    if (OK_DEVICE.test(r.status)) continue;
    // A shared key is down when any of its devices is; its status is the same whatever order Zoom lists them in.
    const st = r.status || "unknown";
    if (!(key in down) || st.localeCompare(down[key]!) < 0) down[key] = st;
  }
  for (const k of shared) delete ids[k];
  return {
    issues,
    down,
    seen: [...seen].sort(),
    ...(issuesRead ? {} : { issuesRead: false }),
    ...(Object.keys(ids).length ? { ids } : {}),
    ...(shared.size ? { shared: [...shared].sort() } : {}),
  };
};

/**
 * Lines up last check's device keys with this check's before comparing. A device whose key changed (a second device
 * with its name arrived, so both are now keyed by Zoom device id, or one left so the id is dropped again) is found by
 * its saved id. A check saved before ids were kept cannot say which of two same-named devices was which: those are
 * named once as not compared and start fresh, never reported as "was online" or "no longer listed".
 */
const carryIds = <T extends RoomDetailFacts>(
  was: T,
  now_: RoomDetailFacts,
): { was: T; skip: Set<string>; split: string[]; fresh: Set<string>; recovered: [string, string][]; removed: [string, string][]; newcomer: Set<string> } => {
  const nowKeys = new Set([...Object.keys(now_.down), ...(now_.seen ?? [])]);
  const oldKeys = new Set([...Object.keys(was.down), ...(was.seen ?? [])]);
  const keyById = new Map(Object.entries(now_.ids ?? {}).map(([k, id]) => [id, k]));
  // Zoom's device id wins over the name: two devices that swapped names keep their own histories (Codex review, 11/27).
  const rename = new Map<string, string>();
  for (const [k, id] of Object.entries(was.ids ?? {})) {
    const to = keyById.get(id);
    if (to && to !== k) rename.set(k, to);
  }
  const skip = new Set<string>();
  const fresh = new Set<string>();
  const newcomer = new Set<string>();
  const split: string[] = [];
  const recovered: [string, string][] = [];
  const left: [string, string][] = [];
  const drop = new Set<string>();
  const nowIdSet = new Set(Object.values(now_.ids ?? {}));
  const targets0 = new Set(rename.values());
  // Saved ids settle a replacement: the old device's id is gone and a different id now has its name, so the old one
  // left and the new one is new; never "back online" by name (Codex review, 11/27).
  const leftById = (k: string) => was.ids?.[k] !== undefined && !nowIdSet.has(was.ids[k]!);
  for (const k of oldKeys) {
    if (rename.has(k) || targets0.has(k) || !nowKeys.has(k) || !leftById(k)) continue;
    const nid = now_.ids?.[k];
    if (nid === undefined || nid === was.ids![k]) continue;
    // Down before and down now under one name: compared as the same device, so a Zoom id that changes on a re-pair
    // never reads as a removal plus a new outage every check (Sonnet review, 11/27).
    if (Object.hasOwn(was.down, k) && Object.hasOwn(now_.down, k)) continue;
    drop.add(k);
    if (Object.hasOwn(was.down, k)) left.push([k, was.down[k]!]);
    if (Object.hasOwn(now_.down, k)) newcomer.add(k);
  }
  for (const old of oldKeys) {
    if (nowKeys.has(old) || rename.has(old) || !old.endsWith(")")) continue;
    const stem = `${old.slice(0, -1)}, Zoom device `;
    const taken = new Set(rename.values());
    const parts = [...nowKeys].filter((k) => k.startsWith(stem) && !oldKeys.has(k) && !taken.has(k));
    if (!parts.length) continue;
    if (leftById(old)) {
      drop.add(old);
      if (Object.hasOwn(was.down, old)) left.push([old, was.down[old]!]);
      for (const p of parts) if (Object.hasOwn(now_.down, p)) newcomer.add(p);
      continue;
    }
    if (parts.length === 1) {
      // A same-named device was already told apart by id last time, and the one with no id then is gone while a new id
      // appeared: either it gained an id or it was replaced, and nothing tells which (Sonnet and Codex reviews, 11/27).
      // Said once, never a false recovery or outage.
      if ([...oldKeys].some((k) => k.startsWith(stem))) {
        drop.add(old);
        // Online before: if the new one is down, that is news either way (Sonnet review, 11/27).
        if (!Object.hasOwn(was.down, old)) {
          if (Object.hasOwn(now_.down, parts[0]!)) fresh.add(parts[0]!);
        } else {
          skip.add(parts[0]!);
          split.push(old);
        }
      }
      continue;
    }
    drop.add(old);
    const oldDown = Object.hasOwn(was.down, old) ? was.down[old]! : undefined;
    const partsDown = parts.filter((p) => Object.hasOwn(now_.down, p));
    if (oldDown === undefined) {
      // It was one device and online: any of them down now is news, worded so a just-installed device is not
      // claimed to have been online (Sonnet review, 11/27).
      for (const p of partsDown) fresh.add(p);
    } else if (!partsDown.length) {
      // All online now, but the down device was never seen again under its old key: it may have been replaced.
      recovered.push([old, oldDown]);
    } else {
      // Down before and some down now: which one is which cannot be told, so it is said once and starts fresh.
      for (const p of parts) skip.add(p);
      split.push(old);
    }
  }
  if (!rename.size && !drop.size) return { was, skip, split, fresh, recovered, removed: [], newcomer };
  // An old key with no saved id that another device's id now claims cannot be told apart: dropped, not guessed.
  const targets = new Set(rename.values());
  const gone = (k: string) => drop.has(k) || (!rename.has(k) && targets.has(k));
  // A down device dropped that way whose own saved id is no longer listed has left the room: said, not swallowed.
  const nowIds = new Set(Object.values(now_.ids ?? {}));
  const removed: [string, string][] = [
    ...left,
    ...Object.entries(was.down).filter(([k]) => !drop.has(k) && !rename.has(k) && targets.has(k) && was.ids?.[k] !== undefined && !nowIds.has(was.ids[k]!)),
  ];
  const down: Record<string, string> = {};
  for (const [k, s] of Object.entries(was.down)) if (!gone(k)) down[rename.get(k) ?? k] = s;
  const seen = was.seen?.filter((k) => !gone(k)).map((k) => rename.get(k) ?? k);
  return { was: { ...was, down, ...(seen ? { seen } : {}) }, skip, split, fresh, recovered, removed, newcomer };
};

/**
 * Checks saved before 11/25 keyed a device Zoom names only by `device_hostname` as "Unnamed device (Type)". When the
 * room now has exactly one device of that type under a name the old check never saw, it is the same device, so the old
 * entry is read under the new name (never a false "was online" plus "no longer listed" pair after the upgrade).
 */
const carryUnnamed = <T extends RoomDetailFacts>(was: T, now_: RoomDetailFacts): T => {
  const oldKeys = new Set([...Object.keys(was.down), ...(was.seen ?? [])]);
  const nowKeys = [...new Set([...Object.keys(now_.down), ...(now_.seen ?? [])])];
  const down = { ...was.down };
  let seen = was.seen ? [...was.seen] : was.seen;
  let changed = false;
  for (const old of oldKeys) {
    const m = /^Unnamed device (\(.*\))$/.exec(old);
    if (!m || nowKeys.includes(old)) continue;
    const fresh = nowKeys.filter((k) => k.endsWith(` ${m[1]}`) && !oldKeys.has(k));
    if (fresh.length !== 1) continue;
    changed = true;
    if (old in down) {
      down[fresh[0]!] = down[old]!;
      delete down[old];
    }
    if (seen) seen = seen.map((k) => (k === old ? fresh[0]! : k));
  }
  return changed ? { ...was, down, ...(seen ? { seen } : {}) } : was;
};

/** Reads the room list, then the detail of every room that looks unhappy now or did last time (up to DETAIL_LIMIT). */
export const readAccount = async (client: ZoomRoomsClient, previous: Snapshot | null, opts: { budgetMs?: number; concurrency?: number; deadline?: number } = {}): Promise<Reading> => {
  const started = Date.now();
  const couldNotCheck: string[] = [];
  // One deadline for the whole reading, room-list pages included. A caller that already waited (what_changed queued
  // behind another call) passes its own earlier deadline, so the wait counts against the same budget.
  const deadline = Math.min(started + (opts.budgetMs ?? DETAIL_BUDGET_MS), opts.deadline ?? Infinity);
  const list = await client.listRooms({ deadline });
  const rawRows = Array.isArray(list) ? list : (list as any)?.rooms;
  // A list in a shape we cannot read is an error, never an empty account (that would read as every room removed).
  if (!Array.isArray(rawRows)) throw new Error("Zoom returned the room list in an unexpected shape, so nothing was compared or saved.");
  const rows: unknown[] = rawRows;
  let fullList = !(isObj(list) && str((list as any).next_page_token));
  if (!fullList) couldNotCheck.push("Room list: more rooms exist than were read, so rooms are not called added or removed");
  // A last page with no token that still counts more rooms than were returned is not whole either (Codex review, 11/27).
  // Read safely: a count in an odd shape is ignored, never a crash (Codex review, 11/27).
  const counted = roomCount(list);
  if (fullList && counted !== undefined && counted > rawRows.length) {
    fullList = false;
    couldNotCheck.push(`Room list: Zoom counts ${counted} rooms but returned ${rawRows.length}, so rooms are not called added or removed`);
  }
  const rooms = new Map<string, RoomListFacts>();
  for (const r of rows) {
    const id = isObj(r) ? str((r as any).id) : "";
    if (!id) {
      fullList = false;
      couldNotCheck.push("Room list: a row had no room id and was skipped");
      continue;
    }
    if (rooms.has(id)) {
      fullList = false;
      couldNotCheck.push(`Room list: room id ${id} appeared twice; kept the last row, and rooms are not called added or removed this time`);
    }
    rooms.set(id, { name: str((r as any).name) || id, status: str((r as any).status) || "unknown", health: str((r as any).health) || "unknown" });
  }
  // An empty list where there were rooms last time is more likely a bad read than a deleted account, so the first one
  // is held back. A second clean empty read in a row confirms it, and the rooms are reported removed (Codex review,
  // 11/25: deleting the last room was otherwise never reported).
  // The confirming read must come 10 minutes to a day after the first (Sonnet review, 11/27), so an immediate re-run
  // never confirms a removal that a lost permission or a wrong account produced, and a week-old hold never does either.
  let emptyList = false;
  let emptyHeldAt: string | undefined;
  if (rooms.size === 0 && previous && Object.keys(previous.rooms).length) {
    // A page that says rooms exist (total_records above zero) is not a clean empty list (Codex review, 11/27).
    const total = roomCount(list) ?? NaN;
    emptyList = fullList && rows.length === 0 && !(total > 0);
    const heldFor = previous.emptyListAt ? started - Date.parse(previous.emptyListAt) : NaN;
    const confirms = emptyList && heldFor >= EMPTY_CONFIRM_MIN_MS && heldFor <= EMPTY_CONFIRM_MAX_MS;
    if (emptyList && heldFor >= 0 && heldFor < EMPTY_CONFIRM_MIN_MS) emptyHeldAt = previous.emptyListAt;
    if (!confirms) {
      fullList = false;
      couldNotCheck.push(
        emptyList
          ? "Room list: Zoom returned no rooms, though there were rooms last time; held back as a possible bad read (a lost permission or a different account also looks like this). If a saved check 10 minutes to a week after the first saved empty one also finds none, the rooms are reported removed"
          : "Room list: Zoom returned no rooms, though there were rooms last time; treated as an incomplete read",
      );
    }
  }
  const wanted = [...rooms.entries()].filter(([id, f]) => {
    const before = prevRoom(previous, id);
    return unhappy(f) || (before && (unhappy(before.list) || (before.detail && (before.detail.issues.length || Object.keys(before.detail.down).length))));
  });
  // Worst now first (offline, then critical, then the rest), so the cap drops the healthiest (Codex review, 11/24).
  const severity = (f: RoomListFacts) => (/^offline$/i.test(f.status) ? 3 : /^critical$/i.test(f.health) ? 2 : unhappy(f) ? 1 : 0);
  wanted.sort(([, a], [, b]) => severity(b) - severity(a));
  const details = new Map<string, RoomDetailFacts>();
  const skippedDetail = wanted.slice(DETAIL_LIMIT).map(([, f]) => f.name);
  // A few rooms at a time, inside one time budget, so a slow Zoom still gets an answer back before the MCP client's
  // 60 s deadline (Codex review, 11/25). A room not read in time is named and keeps its last saved reading.
  const queue = wanted.slice(0, DETAIL_LIMIT);
  const budgetMs = deadline - started;
  const failed = new Map<string, string>();
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const left = deadline - Date.now();
      if (left <= 0) return;
      const [id] = queue[next++]!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), left);
      });
      try {
        const got = await Promise.race([readDetail(client, id), late]);
        if (got !== "late") details.set(id, got);
      } catch (error) {
        failed.set(id, msg(error));
      } finally {
        clearTimeout(timer);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? DETAIL_CONCURRENCY, queue.length)) }, worker));
  // In list order, so the report reads the same however the reads interleaved.
  for (const [id, f] of queue) {
    if (details.has(id)) continue;
    if (failed.has(id)) couldNotCheck.push(`${f.name}: issues and devices could not be read (${failed.get(id)})`);
    else couldNotCheck.push(`${f.name}: issues and devices not read; Zoom was slow, so room details stopped after ${Math.max(0, Math.round(budgetMs / 1000))} s to answer in time`);
  }
  return { rooms, details, fullList, couldNotCheck, skippedDetail, ...(emptyList ? { emptyList } : {}), ...(emptyHeldAt ? { emptyHeldAt } : {}) };
};

// ---------- comparing ----------

export type Direction = "worse" | "better" | "changed";
export interface Change {
  room: string;
  direction: Direction;
  text: string;
}
export interface ChangeReport {
  summary: string;
  text: string;
  changes: Change[];
  notCompared: string[];
  firstRun: boolean;
}

const ago = (iso: string, now: number) => {
  const ms = now - Date.parse(iso);
  if (ms < -60_000) return "at a time later than now; this computer's clock may have changed";
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days} day${days === 1 ? "" : "s"} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const mins = Math.floor(ms / 60_000);
  return mins >= 1 ? `${mins} minute${mins === 1 ? "" : "s"} ago` : "less than a minute ago";
};
const isOffline = (s: string) => /^offline$/i.test(s);
const healthRank = (h: string) => HEALTH_RANK[h.toLowerCase()];

/** Compare a fresh reading with the saved snapshot. */
export const compare = (reading: Reading, previous: Snapshot | null, now: number): ChangeReport => {
  const issuesUnread: string[] = [];
  const notCompared = [...reading.couldNotCheck, ...reading.skippedDetail.map((n) => `${n}: past the ${DETAIL_LIMIT}-room detail limit, so its issues and devices were not compared`)];
  if (!previous) {
    for (const [id, d] of reading.details) for (const k of d.shared ?? []) notCompared.push(`${reading.rooms.get(id)?.name ?? id}: more than one ${k} and Zoom gave no device id to tell them apart, so they were compared as one`);
    const summary = "No previous check to compare against.";
    // What this first check could not read is said now, not only in the structured output (Codex review, 11/25), so
    // the saved starting point is never taken as complete when it is not.
    // Worded for a first check: nothing is compared yet, so "not compared" and "added or removed" clauses do not apply.
    const firstWords = (n: string) =>
      n
        .replace(/, so its issues and devices were not compared$/, ", so its issues and devices were not read")
        .replace(/, so they were compared as one$/, ", so they were read as one")
        .replace(/[,;] (and |so )?rooms are not called added or removed( this time)?/, "");
    const text = notCompared.length ? [summary, "", "Not read in this first check:", ...notCompared.map((n) => `- ${firstWords(n)}`)].join("\n") : summary;
    return { summary, text, changes: [], notCompared, firstRun: true };
  }
  const changes: Change[] = [];
  const add = (room: string, direction: Direction, text: string) => changes.push({ room, direction, text });
  // Two rooms with one name ("Lobby" in two buildings) carry Zoom's room id, so their changes are never merged under one
  // heading or counted as one room (Codex review, 11/25).
  const nameCount = new Map<string, number>();
  const count = (name: string) => nameCount.set(name.toLowerCase(), (nameCount.get(name.toLowerCase()) ?? 0) + 1);
  for (const f of reading.rooms.values()) count(f.name);
  if (reading.fullList) for (const [id, before] of Object.entries(previous.rooms)) if (!reading.rooms.has(id)) count(before.list.name);
  const labelFor = (id: string, name: string) => ((nameCount.get(name.toLowerCase()) ?? 0) > 1 && name !== id ? `${name} (Zoom room ${id})` : name);
  const times: string[] = [];
  for (const [id, now_] of reading.rooms) {
    const before = prevRoom(previous, id);
    const nm = labelFor(id, now_.name);
    if (!before) {
      if (previous.fullListAt && reading.fullList) add(nm, unhappy(now_) ? "worse" : "changed", `New room in the account (${now_.status}, ${now_.health}).`);
      else notCompared.push(`${now_.name}: not in the last check's room list, and ${previous.fullListAt ? "this check's list" : "that list"} was not read in full, so it may not be new`);
      for (const k of reading.details.get(id)?.shared ?? []) notCompared.push(`${now_.name}: more than one ${k} and Zoom gave no device id to tell them apart, so they were read as one`);
      continue;
    }
    // First seen in a partial list after a full one: this full read confirms it is new (Codex review, 11/27).
    // Reported like any new room, with no comparison against the partial reading (Sonnet review, 11/27).
    if (before.list.unconfirmed && reading.fullList && previous.fullListAt) {
      add(nm, unhappy(now_) ? "worse" : "changed", `New room in the account (${now_.status}, ${now_.health}).`);
      continue;
    }
    times.push(before.list.at);
    const was = before.list;
    if (was.name !== now_.name) add(nm, "changed", `Renamed from "${was.name}".`);
    if (!isOffline(was.status) && isOffline(now_.status)) add(nm, "worse", `Went offline (was ${was.status}).`);
    else if (isOffline(was.status) && UP_STATUS.test(now_.status)) add(nm, "better", `Back online (now ${now_.status}).`);
    else if (isOffline(was.status) && !isOffline(now_.status)) add(nm, "changed", `Status now reads "${now_.status}" (was Offline); not counted as back online.`);
    const hw = healthRank(was.health);
    const hn = healthRank(now_.health);
    if (hw !== undefined && hn !== undefined && hn !== hw) add(nm, hn > hw ? "worse" : "better", `Health ${hn > hw ? "worse" : "better"}: ${now_.health} (was ${was.health}).`);
    else if ((hw === undefined) !== (hn === undefined) || (hw === undefined && was.health !== now_.health)) add(nm, "changed", `Health now reads "${now_.health}" (was "${was.health}").`);

    const detailNow = reading.details.get(id);
    let detailWas = before.detail;
    if (!detailNow) {
      // Not read this time. Only a problem if it had something open last time, or looks unhappy now.
      const hadOpen = detailWas && (detailWas.issues.length || Object.keys(detailWas.down).length);
      if ((hadOpen || unhappy(now_)) && !notCompared.some((n) => n.startsWith(`${now_.name}:`))) notCompared.push(`${now_.name}: issues and devices not read this time`);
      continue;
    }
    if (!detailWas) {
      // First detailed reading of this room: what is open is new only if the room looked healthy last time.
      if (!unhappy(was)) {
        for (const i of detailNow.issues) add(nm, "worse", `New issue: ${i} (the room was healthy at the last check).`);
        for (const [d, s] of Object.entries(detailNow.down)) add(nm, "worse", `${d}: ${s} (the room was healthy at the last check).`);
      } else if (detailNow.issues.length || Object.keys(detailNow.down).length) notCompared.push(`${now_.name}: its issues and devices were not read last time, so this is their first reading`);
      // Grouped devices are said on their first reading too (Codex review, 11/27).
      for (const k of detailNow.shared ?? []) notCompared.push(`${now_.name}: more than one ${k} and Zoom gave no device id to tell them apart, so they were compared as one`);
      continue;
    }
    const lined = carryIds(detailWas, detailNow);
    detailWas = carryUnnamed(lined.was, detailNow);
    for (const k of lined.split) notCompared.push(`${now_.name}: ${k.replace(/\)$/, "")}) could not be matched to this check's devices with that name (Zoom device ids changed or were added), so they were not compared this time; they are told apart by id from now on`);
    for (const [k, st] of lined.removed) add(nm, "changed", `${k} (Zoom device ${detailWas.ids?.[k] ?? "?"}): no longer in the room's device list (was ${st}); not counted as back online.`);
    for (const [k, st] of lined.recovered) add(nm, "changed", `${k}: was ${st}; Zoom now lists more than one device with this name, all online (it may have been replaced, so not counted as back online).`);
    // Said when it first happens, not on every check (Sonnet review, 11/27).
    for (const k of (detailNow.shared ?? []).filter((k) => !(detailWas!.shared ?? []).includes(k))) notCompared.push(`${now_.name}: more than one ${k} and Zoom gave no device id to tell them apart, so they were compared as one`);
    // One line for all such rooms, not one per room per check (Sonnet review, 11/25): on a live account it is all of them.
    if (detailWas.issuesRead === false || detailNow.issuesRead === false) issuesUnread.push(nm);
    else {
      const wasKeys = new Set(detailWas.issues.map(issueKey));
      const nowKeys = new Set(detailNow.issues.map(issueKey));
      for (const i of detailNow.issues) if (!wasKeys.has(issueKey(i))) add(nm, "worse", `New issue: ${i}.`);
      for (const i of detailWas.issues) if (!nowKeys.has(issueKey(i))) add(nm, "better", `Issue closed: ${i}.`);
    }
    for (const [d, s] of Object.entries(detailNow.down)) {
      if (lined.skip.has(d)) continue;
      if (lined.newcomer.has(d)) {
        add(nm, "worse", `${d}: ${s} (new in the room's device list since the last check).`);
        continue;
      }
      if (lined.fresh.has(d)) {
        add(nm, "worse", `${d}: ${s} (at the last check this name read as one device, online; Zoom now lists more than one).`);
        continue;
      }
      const prev = detailWas.down[d];
      // A device the last check never listed was not online then; it is new (Codex review, 11/24 and 11/27).
      if (prev === undefined) add(nm, "worse", detailWas.seen && !detailWas.seen.includes(d) ? `${d}: ${s} (new in the room's device list since the last check).` : `${d}: ${s} (was online).`);
      else if (prev.toLowerCase() !== s.toLowerCase()) add(nm, "changed", `${d}: now ${s} (was ${prev}).`);
    }
    // Back online only when the device is still listed; one that is gone from the list was never seen recover.
    for (const [d, s] of Object.entries(detailWas.down)) {
      if (d in detailNow.down) continue;
      if (detailNow.seen && !detailNow.seen.includes(d)) add(nm, "changed", `${d}: no longer in the room's device list (was ${s}); not counted as back online.`);
      else add(nm, "better", `${d}: back online (was ${s}).`);
    }
  }
  for (const [id, before] of Object.entries(previous.rooms)) {
    if (reading.rooms.has(id)) continue;
    // Seen once in a partial list and never confirmed: not called removed (Sonnet review, 11/27).
    if (reading.fullList && before.list.unconfirmed) notCompared.push(`${before.list.name}: seen only in an earlier partial room list and not in this full one, so it is not called added or removed`);
    else if (reading.fullList) add(labelFor(id, before.list.name), "changed", "No longer in the account's room list (removed or renamed to a new id).");
    else notCompared.push(`${before.list.name}: not in this check's room list, which was not read in full`);
  }
  const order: Record<Direction, number> = { worse: 0, changed: 1, better: 2 };
  changes.sort((a, b) => order[a.direction] - order[b.direction]);
  if (issuesUnread.length) notCompared.push(`Open issues for ${issuesUnread.length === 1 ? issuesUnread[0] : `${issuesUnread.length} rooms`}: Zoom's room profile gives no issues list, so only status, health and devices were compared`);
  // "Since the last check" is the latest reading; rooms kept from an older check (a partial list) say how old theirs is.
  times.sort();
  const since = times.length ? times.at(-1)! : null;
  const older = since ? times.filter((t) => Date.parse(since) - Date.parse(t) >= 3_600_000) : [];
  if (older.length) notCompared.push(`${older.length} room${older.length === 1 ? " was" : "s were"} compared with an older reading, from ${ago(older[0]!, now)} (missing from a partial room list in between)`);
  const roomsChanged = new Set(changes.map((c) => c.room)).size;
  const roomsWorse = new Set(changes.filter((c) => c.direction === "worse").map((c) => c.room)).size;
  const when = since ? ` since the last check (${ago(since, now)})` : "";
  const summary = roomsChanged
    ? `${roomsChanged} room${roomsChanged === 1 ? "" : "s"} changed${roomsWorse ? `, ${roomsWorse} for the worse` : ""}${when}.`
    : notCompared.length
      ? `No changes in what could be compared${when}.`
      : `Nothing changed${when}.`;
  const lines = [summary];
  const byRoom = new Map<string, Change[]>();
  for (const c of changes) byRoom.set(c.room, [...(byRoom.get(c.room) ?? []), c]);
  for (const [room, list] of byRoom) lines.push("", `${room}:`, ...list.map((c) => `- [${c.direction}] ${c.text}`));
  if (notCompared.length) lines.push("", "Not compared:", ...notCompared.map((n) => `- ${n}`));
  return { summary, text: lines.join("\n"), changes, notCompared, firstRun: false };
};

/**
 * Issues not read this time (no issues list in Zoom's room profile) keep their last reading, so a later check that can
 * read them still sees an open camera issue close (Codex review, 11/25). Devices are always this reading's.
 */
const keepIssues = (now_: RoomDetailFacts, before: (RoomDetailFacts & { at: string }) | undefined): RoomDetailFacts => {
  if (now_.issuesRead !== false || !before || before.issuesRead === false) return now_;
  const { issuesRead: _unread, ...rest } = now_;
  // The kept issues say when they were read, so a saved check never passes them off as fresh.
  return { ...rest, issues: [...before.issues], issuesAt: before.issuesAt ?? before.at };
};

/** The next snapshot: this reading, with every part not read this time kept from the last one. */
export const nextSnapshot = (reading: Reading, previous: Snapshot | null, account: string, now: number): Snapshot => {
  const at = new Date(now).toISOString();
  const rooms: Record<string, RoomSnapshot> = Object.create(null);
  // Rooms missing from a partial list keep their last reading, so a later full read can still compare them.
  if (previous && !reading.fullList) for (const [id, r] of Object.entries(previous.rooms)) rooms[id] = structuredClone(r);
  for (const [id, f] of reading.rooms) {
    const before = prevRoom(previous, id);
    const detail = reading.details.get(id);
    // A room new since the last full list, seen only in a partial one, stays unconfirmed until a full read.
    const unconfirmed = !reading.fullList && !!previous?.fullListAt && (before ? !!before.list.unconfirmed : true);
    rooms[id] = {
      list: { ...f, at, ...(unconfirmed ? { unconfirmed: true } : {}) },
      // Only what was actually read is saved; a part not read keeps its last reading (or stays unknown).
      ...(detail ? { detail: { ...keepIssues(detail, before?.detail), at } } : before?.detail ? { detail: structuredClone(before.detail) } : {}),
    };
  }
  return {
    version: 1,
    account,
    fullListAt: reading.fullList ? at : previous?.fullListAt ?? null,
    // Kept from the first empty read, so the confirming read is the next one with no rooms.
    ...(reading.emptyList && !reading.fullList ? { emptyListAt: reading.emptyHeldAt ?? at } : {}),
    rooms,
  };
};
