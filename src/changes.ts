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
import type { ZoomRoomsClient } from "./client.ts";
import { deviceName } from "./device-fields.ts";

/** Rooms read in detail (issues and devices) per check: rooms that look unhappy now or did last time. */
export const DETAIL_LIMIT = 25;

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
}
export interface RoomSnapshot {
  list: RoomListFacts & { at: string };
  detail?: RoomDetailFacts & { at: string };
}
export interface Snapshot {
  version: 1;
  /** A one-way fingerprint of the Zoom account, so two accounts are never compared. "demo" for demo data. */
  account: string;
  /** When the whole room list was last read in full. Rooms are called added or removed only between two full reads. */
  fullListAt: string | null;
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
  isObj(r) && isObj(r.list) && isStr(r.list.name) && isStr(r.list.status) && isStr(r.list.health) && isTime(r.list.at) &&
  (r.detail === undefined || (isObj(r.detail) && isTime(r.detail.at) && Array.isArray(r.detail.issues) && r.detail.issues.every(isStr) &&
    isObj(r.detail.down) && Object.values(r.detail.down).every(isStr) &&
    (r.detail.seen === undefined || (Array.isArray(r.detail.seen) && r.detail.seen.every(isStr))) &&
    (r.detail.issuesRead === undefined || typeof r.detail.issuesRead === "boolean")));
export const isSnapshot = (x: unknown): x is Snapshot =>
  isObj(x) && x.version === 1 && isStr(x.account) && (x.fullListAt === null || isTime(x.fullListAt)) && isObj(x.rooms) && Object.values(x.rooms).every(validRoom);

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
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stale = false;
      try {
        stale = Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS;
      } catch {
        stale = true;
      }
      if (!stale) throw new Error("another check is being saved right now");
      rmSync(lock, { force: true });
      fd = openSync(lock, "wx", 0o600);
    }
    try {
      return fn();
    } finally {
      closeSync(fd);
      rmSync(lock, { force: true });
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
    const text = str(isObj(i) ? i.issue ?? i.message ?? i.description : i).replace(/\s+/g, " ");
    if (!text) throw new Error("an open issue came back in a shape that could not be read");
    if (!byKey.has(issueKey(text))) byKey.set(issueKey(text), text);
  }
  const issues = [...byKey.values()].sort();
  const down: Record<string, string> = {};
  const seen = new Set<string>();
  for (const d of rawDevices) {
    if (!isObj(d)) throw new Error("a device came back in a shape that could not be read");
    const status = str(d.status);
    const name = `${deviceName(d) || "Unnamed device"} (${str(d.device_type) || "device"})`;
    seen.add(name);
    if (OK_DEVICE.test(status)) continue;
    down[name] = status || "unknown";
  }
  return { issues, down, seen: [...seen].sort(), ...(issuesRead ? {} : { issuesRead: false }) };
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
export const readAccount = async (client: ZoomRoomsClient, previous: Snapshot | null): Promise<Reading> => {
  const couldNotCheck: string[] = [];
  const list = await client.listRooms();
  const rawRows = Array.isArray(list) ? list : (list as any)?.rooms;
  // A list in a shape we cannot read is an error, never an empty account (that would read as every room removed).
  if (!Array.isArray(rawRows)) throw new Error("Zoom returned the room list in an unexpected shape, so nothing was compared or saved.");
  const rows: unknown[] = rawRows;
  let fullList = !(isObj(list) && str((list as any).next_page_token));
  if (!fullList) couldNotCheck.push("Room list: more rooms exist than were read, so rooms are not called added or removed");
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
  // An empty list where there were rooms last time is far more likely a bad read than a deleted account.
  if (rooms.size === 0 && previous && Object.keys(previous.rooms).length) {
    fullList = false;
    couldNotCheck.push("Room list: Zoom returned no rooms, though there were rooms last time; treated as an incomplete read");
  }
  const wanted = [...rooms.entries()].filter(([id, f]) => {
    const before = prevRoom(previous, id);
    return unhappy(f) || (before && (unhappy(before.list) || (before.detail && (before.detail.issues.length || Object.keys(before.detail.down).length))));
  });
  // Worst now first, so the cap drops the healthiest.
  wanted.sort(([, a], [, b]) => (unhappy(b) ? 1 : 0) - (unhappy(a) ? 1 : 0));
  const details = new Map<string, RoomDetailFacts>();
  const skippedDetail = wanted.slice(DETAIL_LIMIT).map(([, f]) => f.name);
  for (const [id, f] of wanted.slice(0, DETAIL_LIMIT)) {
    try {
      details.set(id, await readDetail(client, id));
    } catch (error) {
      couldNotCheck.push(`${f.name}: issues and devices could not be read (${msg(error)})`);
    }
  }
  return { rooms, details, fullList, couldNotCheck, skippedDetail };
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
    const summary = "No previous check to compare against.";
    return { summary, text: summary, changes: [], notCompared, firstRun: true };
  }
  const changes: Change[] = [];
  const add = (room: string, direction: Direction, text: string) => changes.push({ room, direction, text });
  const times: string[] = [];
  for (const [id, now_] of reading.rooms) {
    const before = prevRoom(previous, id);
    if (!before) {
      if (previous.fullListAt && reading.fullList) add(now_.name, unhappy(now_) ? "worse" : "changed", `New room in the account (${now_.status}, ${now_.health}).`);
      else notCompared.push(`${now_.name}: not in the last check's room list, which was not read in full, so it may not be new`);
      continue;
    }
    times.push(before.list.at);
    const was = before.list;
    if (was.name !== now_.name) add(now_.name, "changed", `Renamed from "${was.name}".`);
    if (!isOffline(was.status) && isOffline(now_.status)) add(now_.name, "worse", `Went offline (was ${was.status}).`);
    else if (isOffline(was.status) && UP_STATUS.test(now_.status)) add(now_.name, "better", `Back online (now ${now_.status}).`);
    else if (isOffline(was.status) && !isOffline(now_.status)) add(now_.name, "changed", `Status now reads "${now_.status}" (was Offline); not counted as back online.`);
    const hw = healthRank(was.health);
    const hn = healthRank(now_.health);
    if (hw !== undefined && hn !== undefined && hn !== hw) add(now_.name, hn > hw ? "worse" : "better", `Health ${hn > hw ? "worse" : "better"}: ${now_.health} (was ${was.health}).`);
    else if ((hw === undefined) !== (hn === undefined) || (hw === undefined && was.health !== now_.health)) add(now_.name, "changed", `Health now reads "${now_.health}" (was "${was.health}").`);

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
        for (const i of detailNow.issues) add(now_.name, "worse", `New issue: ${i} (the room was healthy at the last check).`);
        for (const [d, s] of Object.entries(detailNow.down)) add(now_.name, "worse", `${d}: ${s} (the room was healthy at the last check).`);
      } else if (detailNow.issues.length || Object.keys(detailNow.down).length) notCompared.push(`${now_.name}: its issues and devices were not read last time, so this is their first reading`);
      continue;
    }
    detailWas = carryUnnamed(detailWas, detailNow);
    // One line for all such rooms, not one per room per check (Sonnet review, 11/25): on a live account it is all of them.
    if (detailWas.issuesRead === false || detailNow.issuesRead === false) issuesUnread.push(now_.name);
    else {
      const wasKeys = new Set(detailWas.issues.map(issueKey));
      const nowKeys = new Set(detailNow.issues.map(issueKey));
      for (const i of detailNow.issues) if (!wasKeys.has(issueKey(i))) add(now_.name, "worse", `New issue: ${i}.`);
      for (const i of detailWas.issues) if (!nowKeys.has(issueKey(i))) add(now_.name, "better", `Issue closed: ${i}.`);
    }
    for (const [d, s] of Object.entries(detailNow.down)) {
      const prev = detailWas.down[d];
      if (prev === undefined) add(now_.name, "worse", `${d}: ${s} (was online).`);
      else if (prev.toLowerCase() !== s.toLowerCase()) add(now_.name, "changed", `${d}: now ${s} (was ${prev}).`);
    }
    // Back online only when the device is still listed; one that is gone from the list was never seen recover.
    for (const [d, s] of Object.entries(detailWas.down)) {
      if (d in detailNow.down) continue;
      if (detailNow.seen && !detailNow.seen.includes(d)) add(now_.name, "changed", `${d}: no longer in the room's device list (was ${s}); not counted as back online.`);
      else add(now_.name, "better", `${d}: back online (was ${s}).`);
    }
  }
  for (const [id, before] of Object.entries(previous.rooms)) {
    if (reading.rooms.has(id)) continue;
    if (reading.fullList) add(before.list.name, "changed", "No longer in the account's room list (removed or renamed to a new id).");
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
const keepIssues = (now_: RoomDetailFacts, before: RoomDetailFacts | undefined): RoomDetailFacts => {
  if (now_.issuesRead !== false || !before || before.issuesRead === false) return now_;
  const { issuesRead: _unread, ...rest } = now_;
  return { ...rest, issues: [...before.issues] };
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
    rooms[id] = {
      list: { ...f, at },
      // Only what was actually read is saved; a part not read keeps its last reading (or stays unknown).
      ...(detail ? { detail: { ...keepIssues(detail, before?.detail), at } } : before?.detail ? { detail: structuredClone(before.detail) } : {}),
    };
  }
  return { version: 1, account, fullListAt: reading.fullList ? at : previous?.fullListAt ?? null, rooms };
};
