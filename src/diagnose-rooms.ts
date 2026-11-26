// "Is something shared going on across these rooms?" (2026-11-20). get_rooms_needing_attention already ranks the
// problem rooms; diagnose_room explains one. This one runs diagnose_room on every problem room and looks for causes the
// rooms share, so a tech with ten unhappy rooms fixes one switch or one firmware instead of visiting ten rooms:
// - room computers offline in the same place (building and floor both known, or the same location id),
// - the same device model failing in several rooms,
// - failing devices of one kind on the same firmware, across different models,
// - the same kind of problem (camera, microphone, ...) in several rooms when no group above already covers it.
// Only real failures count (a device that is "Updating" is not failing), and devices in a room whose computer is offline
// are left out of the device groups: they are most likely a side effect. Groups come worst first, each with one check,
// then a short per-room list. Read-only; it never reports all clear while any room could not be read, and it never says
// "no shared cause" without saying which rooms it did not get to.
import { cleanName } from "./move-to.ts";
import { levelOf } from "./attention.ts";
import { alertsNote, devicesClearLine, NO_ALERTS } from "./all-clear.ts";
import type { ZoomRoomsClient } from "./client.ts";
import { PlaceNamer } from "./locations.ts";
import { diagnoseRoom, FAILURE, UP_STATUS, type FindingLevel, type RoomDiagnosis } from "./diagnose.ts";

export type PatternKind = "location-offline" | "same-model" | "same-firmware" | "same-problem";

export interface RoomPattern {
  kind: PatternKind;
  level: FindingLevel;
  /** Plain description, e.g. "3 room computers offline on Building 1, 4th Floor". */
  title: string;
  /** Room names, one per room (rooms are told apart by id, so two rooms with one name both appear). */
  rooms: string[];
  roomIds: string[];
  /** One line of evidence per room or device. */
  evidence: string[];
  check: string;
}

export interface RoomRow {
  id: string;
  name: string;
  level: FindingLevel | "could_not_check";
  findings: number;
  top: string | null;
  couldNotCheck: number;
}

export interface RoomsDiagnosis {
  summary: string;
  view: "rooms-diagnosis";
  total: number;
  needAttention: number;
  patterns: RoomPattern[];
  rooms: RoomRow[];
  /** Problem rooms past the detail limit: counted and named, not diagnosed. */
  notDiagnosed: string[];
  couldNotCheck: string[];
  allClear: boolean;
  /**
   * Every room is up and every device read is online, with the only gap that Zoom's room profile carries no alerts for
   * some rooms. Never true when allClear is; says the account looks fine as far as Zoom lets it be read.
   */
  devicesClear: boolean;
  /** Why any place shows a Zoom location code instead of a name, or null. Never affects allClear. */
  placeNote: string | null;
}

/** Problem rooms diagnosed per call, the same cap as get_rooms_needing_attention. */
export const ROOMS_DETAIL_LIMIT = 15;
/** Offline times this close together read as one event. */
const SAME_EVENT_MS = 15 * 60_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const names = (list: string[], max = 6) => (list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`);
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const KIND_WORDS: [string, RegExp][] = [
  ["camera", /camera/i],
  ["microphone", /\bmics?\b|microphone/i],
  ["speaker", /speaker|\baudio\b/i],
  ["display", /display|screen|hdmi|\btv\b/i],
  ["controller", /controller|touch ?panel/i],
  ["room computer load", /\bcpu\b|memory|overload/i],
];
const kindOf = (text: string): string | null => KIND_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;

/** A name that only says what the device is ("Display", "Camera 1", "Zoom Rooms Controller") is not a model. */
const GENERIC = /^(device|display|screen|tv|camera|cam|speaker|speakers|mic|microphone|controller|touch ?panel|zoom rooms controller|zoom rooms)$/i;
const isModel = (name: string) => {
  const base = name.replace(/[\s#-]*\d+$/, "").trim();
  return base.length >= 4 && !GENERIC.test(base);
};
/** Firmware strings that say nothing about the version. */
const NO_FIRMWARE = /^(n\/?a|unknown|none|null|-|0|0\.0|0\.0\.0)$/i;
const realFirmware = (f: string | null) => (f && !NO_FIRMWARE.test(f.trim()) ? f.trim() : null);

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const levelOfAll = (levels: FindingLevel[]): FindingLevel => (levels.includes("critical") ? "critical" : "warning");

/** Build the shared-cause groups from per-room diagnoses. Exported for tests. */
export const findPatterns = (diagnoses: RoomDiagnosis[]): RoomPattern[] => {
  const patterns: RoomPattern[] = [];
  const read = diagnoses.filter((d) => d.room);
  const isOffline = (d: RoomDiagnosis) => d.findings.some((f) => f.subject === "Room computer offline");

  // 1. Room computers offline in the same place.
  const offlineBy = new Map<string, RoomDiagnosis[]>();
  for (const d of read.filter(isOffline)) {
    if (!d.room!.placeKey) continue;
    offlineBy.set(d.room!.placeKey, [...(offlineBy.get(d.room!.placeKey) ?? []), d]);
  }
  for (const ds of offlineBy.values()) {
    if (ds.length < 2) continue;
    const where = ds[0]!.room!.where!;
    const times = ds.map((d) => Date.parse(d.room!.lastOnline ?? ""));
    const known = times.every((t) => !Number.isNaN(t));
    const spread = known ? Math.max(...times) - Math.min(...times) : Infinity;
    patterns.push({
      kind: "location-offline",
      level: "critical",
      title: `${plural(ds.length, "room computer")} offline on ${where}${spread <= SAME_EVENT_MS ? `, last online within ${Math.max(1, Math.round(spread / 60_000))} min of each other` : ""}`,
      rooms: ds.map((d) => d.room!.name),
      roomIds: ds.map((d) => d.room!.id),
      evidence: ds.map((d) => `${d.room!.name}: offline${d.room!.lastOnline ? `, last online ${d.room!.lastOnline}` : ""}`),
      check: `Check the network switch and power that serve ${where} first; if they are fine, restart each room computer.`,
    });
  }

  // Failing devices: a failure status only, and not in rooms whose computer is offline (likely a side effect).
  type Failing = { roomId: string; room: string; name: string; type: string; firmware: string | null; status: string; level: FindingLevel };
  const failing: Failing[] = [];
  for (const d of read.filter((x) => !isOffline(x)))
    for (const dev of d.devices.filter((x) => !x.ok && FAILURE.test(x.status))) {
      const finding = d.findings.find((f) => f.subject.startsWith(`${dev.name} (${dev.type}):`));
      failing.push({ roomId: d.room!.id, room: d.room!.name, name: dev.name, type: dev.type, firmware: realFirmware(dev.firmware), status: dev.status, level: finding?.level ?? "warning" });
    }
  const roomsOf = (fs: Failing[]) => {
    const seen = new Map<string, string>();
    for (const f of fs) if (!seen.has(f.roomId)) seen.set(f.roomId, f.room);
    return { roomIds: [...seen.keys()], rooms: [...seen.values()] };
  };

  // 2. The same device model failing in several rooms.
  const byModel = new Map<string, Failing[]>();
  for (const f of failing.filter((x) => isModel(x.name))) {
    const k = `${norm(f.name)}|${norm(f.type)}`;
    byModel.set(k, [...(byModel.get(k) ?? []), f]);
  }
  for (const fs of byModel.values()) {
    const { roomIds, rooms } = roomsOf(fs);
    if (roomIds.length < 2) continue;
    const fw = fs[0]!.firmware;
    const oneFirmware = fw !== null && fs.every((f) => f.firmware === fw);
    patterns.push({
      kind: "same-model",
      level: levelOfAll(fs.map((f) => f.level)),
      title: `${fs[0]!.name} (${fs[0]!.type}) failing in ${plural(roomIds.length, "room")}${oneFirmware ? `, all on firmware ${fw}` : ""}`,
      rooms,
      roomIds,
      evidence: fs.map((f) => `${f.room}: ${f.status}${f.firmware ? `, firmware ${f.firmware}` : ""}`),
      check: `Look for a known issue or a recent firmware change for the ${fs[0]!.name} before swapping hardware; fix one room first and confirm it holds.`,
    });
  }

  // 3. One kind of device failing on the same firmware across different models.
  const byFirmware = new Map<string, Failing[]>();
  for (const f of failing.filter((x) => x.firmware)) {
    const k = `${norm(f.type)}|${f.firmware}`;
    byFirmware.set(k, [...(byFirmware.get(k) ?? []), f]);
  }
  for (const fs of byFirmware.values()) {
    const { roomIds, rooms } = roomsOf(fs);
    const models = new Set(fs.map((f) => norm(f.name)));
    if (roomIds.length < 2 || models.size < 2) continue;
    const type = fs[0]!.type.toLowerCase();
    patterns.push({
      kind: "same-firmware",
      level: levelOfAll(fs.map((f) => f.level)),
      title: `${plural(fs.length, `failing ${type}`)} on firmware ${fs[0]!.firmware} across ${plural(roomIds.length, "room")}`,
      rooms,
      roomIds,
      evidence: fs.map((f) => `${f.room}: ${f.name}, ${f.status}`),
      check: `Firmware ${fs[0]!.firmware} is the common factor: check its release notes and whether a newer or older version fixes it, in one room first.`,
    });
  }

  // 4. The same kind of problem in several rooms (not counting offline rooms), unless a group above already covers that
  // kind of problem in exactly these rooms.
  const byKind = new Map<string, { roomId: string; room: string; text: string; level: FindingLevel }[]>();
  for (const d of read.filter((x) => !isOffline(x)))
    for (const f of d.findings) {
      // A device finding counts only when the device has really failed (not "Updating" or similar).
      const dev = d.devices.find((x) => f.subject === `${x.name} (${x.type}): ${x.status}`);
      if (dev && !FAILURE.test(dev.status)) continue;
      const kind = kindOf(f.subject);
      if (!kind) continue;
      const list = byKind.get(kind) ?? [];
      if (!list.some((x) => x.roomId === d.room!.id)) list.push({ roomId: d.room!.id, room: d.room!.name, text: f.subject, level: f.level });
      byKind.set(kind, list);
    }
  for (const [kind, list] of byKind) {
    const roomIds = list.map((x) => x.roomId);
    if (roomIds.length < 2 || patterns.some((p) => sameSet(p.roomIds, roomIds) && kindOf(p.title) === kind)) continue;
    patterns.push({
      kind: "same-problem",
      level: levelOfAll(list.map((x) => x.level)),
      title: `${kind[0]!.toUpperCase()}${kind.slice(1)} problems in ${plural(roomIds.length, "room")}`,
      rooms: list.map((x) => x.room),
      roomIds,
      evidence: list.map((x) => `${x.room}: ${x.text}`),
      check: "Different hardware, same symptom: check what these rooms share (network segment, recent change, Zoom Rooms version) before treating them one by one.",
    });
  }

  const order: Record<PatternKind, number> = { "location-offline": 0, "same-model": 1, "same-firmware": 2, "same-problem": 3 };
  return patterns.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1) || order[a.kind] - order[b.kind] || b.roomIds.length - a.roomIds.length);
};

export const diagnoseRooms = async (client: ZoomRoomsClient, now = Date.now(), limit = ROOMS_DETAIL_LIMIT): Promise<RoomsDiagnosis> => {
  const couldNotCheck: string[] = [];
  let rooms: any[];
  try {
    const all = (await client.listRooms()) as any;
    const raw = Array.isArray(all) ? all : arr(all?.rooms);
    rooms = raw.filter((r) => r !== null && typeof r === "object" && !Array.isArray(r));
    if (rooms.length < raw.length) couldNotCheck.push(`Room list: ${plural(raw.length - rooms.length, "entry", "entries")} could not be read.`);
    if (str(all?.next_page_token)) couldNotCheck.push("Room list: Zoom has more pages of rooms than were read.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { summary: `Could not read the room list, so the rooms could not be diagnosed: ${reason}. This is not an all-clear.`, view: "rooms-diagnosis", total: 0, needAttention: 0, patterns: [], rooms: [], notDiagnosed: [], couldNotCheck: [`Room list: ${reason}`], allClear: false, devicesClear: false, placeNote: null };
  }

  // A room listed twice is one room, kept by its worse row and named, so a duplicate never hides a problem behind
  // a reassuring answer (Sonnet review, 11/26).
  const rank = (r: any) => (levelOf(r) === "critical" ? 2 : levelOf(r) === "warning" ? 1 : 0);
  const kept = new Map<string, number>();
  const deduped: any[] = [];
  for (const r of rooms) {
    const id = str(r.id) || str(r.room_id);
    if (!id) {
      deduped.push(r);
      continue;
    }
    const at = kept.get(id);
    if (at === undefined) {
      kept.set(id, deduped.length);
      deduped.push(r);
      continue;
    }
    couldNotCheck.push(`Room list: room id ${cleanName(id)} appeared twice; its worse row was kept.`);
    if (rank(r) > rank(deduped[at])) deduped[at] = r;
  }
  rooms = deduped;

  // Rooms that are not problems but whose health or status could not be classed: they are named in the answer too.
  let unclassed = rooms.filter((r) => !levelOf(r) && (!/^healthy$/i.test(str(r.health)) || !UP_STATUS.test(str(r.status))));
  // Offline first, then critical, then warning: the same order as get_rooms_needing_attention.
  const problems = rooms
    .map((r) => ({ r, level: levelOf(r) }))
    .filter((x) => x.level !== null)
    .sort((a, b) => (a.level === b.level ? Number(str(b.r.status).toLowerCase() === "offline") - Number(str(a.r.status).toLowerCase() === "offline") : a.level === "critical" ? -1 : 1));

  // One location-list read shared by every room in this call.
  const places = new PlaceNamer(client);
  const diagnoses = await Promise.all(problems.slice(0, limit).map(({ r }) => diagnoseRoom(client, str(r.id), now, r, places)));
  // Zoom's documented room list has no health field (Codex review, 11/25): an up room with none could still have a
  // device down, so it is read too, with whatever room is left under the limit. One with a finding is a problem room.
  const quiet = rooms.filter((r) => !levelOf(r) && !str(r.health) && UP_STATUS.test(str(r.status)) && (str(r.id) || str(r.room_id)));
  const spare = Math.max(0, limit - diagnoses.length);
  const probed = await Promise.all(quiet.slice(0, spare).map((r) => diagnoseRoom(client, str(r.id) || str(r.room_id), now, r, places).then((d) => ({ r, d }))));
  const probeFailed: { r: any; why: string }[] = [];
  // Read with every device online, but Zoom's profile had no alerts list (the documented profile never does).
  const alertsUnread: any[] = [];
  for (const { r, d } of probed) {
    // diagnoseRoom always notes the missing health; that is why the room was read, so it is not repeated here.
    const gaps = d.couldNotCheck.filter((c) => !/^Health: "not reported"/.test(c));
    if (!d.findings.length) {
      // Read cleanly (devices online, open issues read and none open): its health comes from that reading, so it is
      // not listed as unclassed (11/26: on a real account allClear was never true). Missing alerts are named once.
      if (d.room && gaps.length && gaps.every((g) => NO_ALERTS.test(g))) {
        alertsUnread.push(r);
        unclassed = unclassed.filter((u) => u !== r);
      } else if (d.room && !gaps.length) unclassed = unclassed.filter((u) => u !== r);
      else {
        probeFailed.push({ r, why: d.room ? `part of it could not be read (${gaps.join("; ")})` : `it could not be read (${d.summary})` });
        unclassed = unclassed.filter((u) => u !== r);
      }
      continue;
    }
    problems.push({ r, level: d.findings.some((f) => f.level === "critical") ? "critical" : "warning" });
    diagnoses.push(d);
    unclassed = unclassed.filter((u) => u !== r);
  }
  // Rooms found by reading them keep the worst-first order (critical before warning, offline first) with the rest.
  if (probed.some(({ d }) => d.findings.length)) {
    const rank = (x: { r: any; level: string | null }) => (x.level === "critical" ? 0 : 2) - Number(str(x.r.status).toLowerCase() === "offline");
    const pairs = problems.map((x, i) => ({ x, d: diagnoses[i]! })).sort((a, b) => rank(a.x) - rank(b.x));
    problems.splice(0, problems.length, ...pairs.map((p) => p.x));
    diagnoses.splice(0, diagnoses.length, ...pairs.map((p) => p.d));
  }
  const unprobed = quiet.length - probed.length;
  const probeNotes: string[] = [];
  if (unprobed > 0) probeNotes.push(`${plural(unprobed, "more room")} with no health from Zoom ${unprobed === 1 ? "was" : "were"} not read (past the limit of ${limit} rooms read per call).`);
  const placeNote = places.note();
  // A name two rooms named in this answer share (problem rooms and unclassed rooms) carries Zoom's room id, the same
  // label the other tools use for problem rooms. Healthy rooms are never named, so a healthy twin adds nothing.
  // get_rooms_needing_attention never names unclassed rooms, so there a problem room with only an unclassed twin
  // stays bare; adding the id here is more information, never a different room.
  const named = [...problems.map(({ r }) => r), ...unclassed, ...probeFailed.map((p) => p.r)];
  const shared = (name: string) => named.filter((r) => (str(r.name) || str(r.id)).toLowerCase() === name.toLowerCase()).length > 1;
  const labelOf = (name: string, id: string) => (shared(name) && id && name !== id ? `${name} (Zoom room ${cleanName(id)})` : name);
  // One label per room, from its row in the room list (the detail's name can differ), looked up by id everywhere.
  const idOf = (r: any) => str(r.id) || str(r.room_id);
  const labels = new Map(problems.map(({ r }) => [idOf(r), labelOf(str(r.name) || idOf(r), idOf(r))]));
  for (const r of unclassed) {
    const label = labelOf(str(r.name) || idOf(r), idOf(r));
    if (!/^healthy$/i.test(str(r.health))) couldNotCheck.push(`${label}: health is "${str(r.health) || "not reported"}", so it could not be classed as healthy.`);
    else couldNotCheck.push(`${label}: status is "${str(r.status) || "not reported"}", so the room computer could not be classed as up.`);
  }
  for (const { r, why } of probeFailed) couldNotCheck.push(`${labelOf(str(r.name) || idOf(r), idOf(r))}: Zoom gives no health and ${why}.`);
  if (alertsUnread.length) couldNotCheck.push(alertsNote(alertsUnread.length));
  couldNotCheck.push(...probeNotes);
  const notDiagnosed = problems.slice(limit).map(({ r }) => labels.get(idOf(r))!);
  const patterns = findPatterns(diagnoses);

  const rows: RoomRow[] = diagnoses.map((d, i) => {
    const r = problems[i]!.r;
    if (!d.room) return { id: str(r.id), name: str(r.name) || str(r.id), level: "could_not_check", findings: 0, top: null, couldNotCheck: d.couldNotCheck.length };
    const level: FindingLevel = d.findings.some((f) => f.level === "critical") ? "critical" : "warning";
    return { id: d.room.id, name: d.room.name, level, findings: d.findings.length, top: d.findings[0]?.subject ?? null, couldNotCheck: d.couldNotCheck.length };
  });
  diagnoses.forEach((d, i) => {
    // By the room's row in the list, not the detail's id, which Zoom could give differently.
    const label = labels.get(idOf(problems[i]!.r)) ?? d.room?.name ?? "A room";
    if (d.couldNotCheck.length) couldNotCheck.push(...d.couldNotCheck.map((c) => `${label}: ${c}`));
  });

  // Rooms the patterns did not see: past the limit, or not read at all.
  const unread = rows.filter((r) => r.level === "could_not_check").length;
  const unseen = notDiagnosed.length + unread;
  const caveat = unseen ? ` ${plural(unseen, "problem room")} could not be included (${[notDiagnosed.length ? `${notDiagnosed.length} past the limit` : "", unread ? `${unread} could not be read` : ""].filter(Boolean).join(", ")}), so a shared cause involving ${unseen === 1 ? "it" : "them"} would not show here.` : "";

  const allClear = rooms.length > 0 && problems.length === 0 && couldNotCheck.length === 0;
  const devicesClear = !allClear && rooms.length > 0 && problems.length === 0 && alertsUnread.length > 0 && couldNotCheck.length === 1 && rooms.every((r) => UP_STATUS.test(str(r.status)));
  const lines: string[] = [];
  if (rooms.length === 0) lines.push(`The account has no rooms to diagnose${couldNotCheck.length ? " that could be read" : ""}. This is not an all-clear: there is nothing to check.`);
  else if (allClear) lines.push(rooms.length === 1 ? "The 1 room is healthy and not offline." : `All ${rooms.length} rooms are healthy and none is offline.`);
  else if (devicesClear) lines.push(devicesClearLine(rooms.length, alertsUnread.length));
  else if (problems.length === 0) lines.push("No room reports a problem, but not everything could be read, so this is not an all-clear.");
  else {
    const head = `${problems.length} of ${plural(rooms.length, "room")} ${problems.length === 1 ? "needs" : "need"} attention.`;
    const among = unseen ? `among the ${plural(diagnoses.length - unread, "room")} diagnosed` : "across the rooms";
    lines.push(
      `${head} ${
        patterns.length ? `${plural(patterns.length, "shared cause")} found ${among}; start with: ${patterns[0]!.title}.` : `No shared cause ${among}: each problem looks local, so work down the list.`
      }${caveat}`,
    );
    if (patterns.length) {
      lines.push("", "Shared causes, worst first:");
      patterns.forEach((p, i) => lines.push(`${i + 1}. [${p.level}] ${p.title}`, ...p.evidence.map((e) => `   - ${e}`), `   Check: ${p.check}`));
    }
    lines.push("", "Per room (diagnose_room with its id for the full answer):");
    for (const row of rows)
      lines.push(`- ${row.name} (id ${row.id}): ${row.level === "could_not_check" ? "could not be read" : `${row.level}, ${plural(row.findings, "finding")}${row.top ? `; first: ${row.top}` : ""}`}${row.level !== "could_not_check" && row.couldNotCheck ? `; ${plural(row.couldNotCheck, "part")} could not be read` : ""}`);
    if (notDiagnosed.length) lines.push(`${plural(notDiagnosed.length, "more problem room")} not diagnosed in this call: ${names(notDiagnosed, 10)}.`);
  }
  if (couldNotCheck.length) lines.push("", "Could not check:", ...couldNotCheck.map((c) => `- ${c}`));
  if (placeNote) lines.push("", placeNote);
  return { summary: lines.join("\n"), view: "rooms-diagnosis", total: rooms.length, needAttention: problems.length, patterns, rooms: rows, notDiagnosed, couldNotCheck, allClear, devicesClear, placeNote };
};
