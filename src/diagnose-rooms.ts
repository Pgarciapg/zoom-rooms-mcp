// "Is something shared going on across these rooms?" (2026-11-20). get_rooms_needing_attention already ranks the
// problem rooms; diagnose_room explains one. This one runs diagnose_room on every problem room and looks for causes the
// rooms share, so a tech with ten unhappy rooms fixes one switch or one firmware instead of visiting ten rooms:
// - room computers offline in the same building and floor (often one network switch or power circuit),
// - the same device model failing in several rooms,
// - failing devices of one kind on the same firmware, across different models,
// - the same kind of problem (camera, microphone, ...) in several rooms when no group above already covers it.
// Groups come worst first, each with one check, then a short per-room list. Read-only; it never reports all clear while
// any room could not be read.
import { levelOf } from "./attention.ts";
import type { ZoomRoomsClient } from "./client.ts";
import { diagnoseRoom, type FindingLevel, type RoomDiagnosis } from "./diagnose.ts";

export type PatternKind = "location-offline" | "same-model" | "same-firmware" | "same-problem";

export interface RoomPattern {
  kind: PatternKind;
  level: FindingLevel;
  /** Plain description, e.g. "Room computers offline on Building 1, 4th Floor". */
  title: string;
  rooms: string[];
  /** One example line of evidence per room. */
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
}

/** Problem rooms diagnosed per call, the same cap as get_rooms_needing_attention. */
export const ROOMS_DETAIL_LIMIT = 15;
/** Offline times this close together read as one event. */
const SAME_EVENT_MS = 15 * 60_000;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const names = (list: string[], max = 6) => (list.length <= max ? list.join(", ") : `${list.slice(0, max).join(", ")} and ${list.length - max} more`);

const KIND_WORDS: [string, RegExp][] = [
  ["camera", /camera/i],
  ["microphone", /\bmic|microphone/i],
  ["speaker", /speaker|audio/i],
  ["display", /display|screen|hdmi|\btv\b/i],
  ["controller", /controller|touch/i],
  ["room computer load", /cpu|memory|overload|slow/i],
];
const kindOf = (text: string): string | null => KIND_WORDS.find(([, re]) => re.test(text))?.[0] ?? null;

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Build the shared-cause groups from per-room diagnoses. Exported for tests. */
export const findPatterns = (diagnoses: RoomDiagnosis[]): RoomPattern[] => {
  const patterns: RoomPattern[] = [];
  const read = diagnoses.filter((d) => d.room);

  // 1. Room computers offline on the same building and floor.
  const offlineBy = new Map<string, RoomDiagnosis[]>();
  for (const d of read) {
    if (!d.findings.some((f) => f.subject === "Room computer offline") || !d.room!.where) continue;
    offlineBy.set(d.room!.where, [...(offlineBy.get(d.room!.where) ?? []), d]);
  }
  for (const [where, ds] of offlineBy) {
    if (ds.length < 2) continue;
    const times = ds.map((d) => Date.parse(d.room!.lastOnline ?? "")).filter((t) => !Number.isNaN(t));
    const together = times.length === ds.length && Math.max(...times) - Math.min(...times) <= SAME_EVENT_MS;
    patterns.push({
      kind: "location-offline",
      level: "critical",
      title: `${plural(ds.length, "room computer")} offline on ${where}${together ? `, last online within ${Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60_000))} min of each other` : ""}`,
      rooms: ds.map((d) => d.room!.name),
      evidence: ds.map((d) => `${d.room!.name}: offline${d.room!.lastOnline ? `, last online ${d.room!.lastOnline}` : ""}`),
      check: `Check the network switch and power that serve ${where} first; if they are fine, restart each room computer.`,
    });
  }

  // 2. The same device model failing in several rooms.
  type Failing = { room: string; name: string; type: string; firmware: string | null; status: string; level: FindingLevel };
  const failing: Failing[] = [];
  for (const d of read)
    for (const dev of d.devices.filter((x) => !x.ok)) {
      const finding = d.findings.find((f) => f.subject.startsWith(`${dev.name} (${dev.type}):`));
      failing.push({ room: d.room!.name, name: dev.name, type: dev.type, firmware: dev.firmware, status: dev.status, level: finding?.level ?? "warning" });
    }
  // Generic names ("Device", "Display", "Zoom Rooms Controller") are not a model; skip them.
  const isModel = (f: Failing) => f.name.length >= 4 && !/^(device|display|camera|speaker|microphone|controller|zoom rooms controller)$/i.test(f.name);
  const byModel = new Map<string, Failing[]>();
  for (const f of failing.filter(isModel)) byModel.set(`${f.name}|${f.type}`, [...(byModel.get(`${f.name}|${f.type}`) ?? []), f]);
  for (const fs of byModel.values()) {
    const rooms = [...new Set(fs.map((f) => f.room))];
    if (rooms.length < 2) continue;
    const firmwares = [...new Set(fs.map((f) => f.firmware).filter(Boolean))];
    patterns.push({
      kind: "same-model",
      level: fs.some((f) => f.level === "critical") ? "critical" : "warning",
      title: `${fs[0]!.name} (${fs[0]!.type}) failing in ${plural(rooms.length, "room")}${firmwares.length === 1 ? `, all on firmware ${firmwares[0]}` : ""}`,
      rooms,
      evidence: fs.map((f) => `${f.room}: ${f.status}${f.firmware ? `, firmware ${f.firmware}` : ""}`),
      check: `Look for a known issue or a recent firmware change for the ${fs[0]!.name} before swapping hardware; fix one room first and confirm it holds.`,
    });
  }

  // 3. One kind of device failing on the same firmware across different models.
  const byFirmware = new Map<string, Failing[]>();
  for (const f of failing.filter((x) => x.firmware)) byFirmware.set(`${f.type.toLowerCase()}|${f.firmware}`, [...(byFirmware.get(`${f.type.toLowerCase()}|${f.firmware}`) ?? []), f]);
  for (const fs of byFirmware.values()) {
    const rooms = [...new Set(fs.map((f) => f.room))];
    const models = new Set(fs.map((f) => f.name));
    if (rooms.length < 2 || models.size < 2) continue;
    patterns.push({
      kind: "same-firmware",
      level: fs.some((f) => f.level === "critical") ? "critical" : "warning",
      title: `${plural(fs.length, `failing ${fs[0]!.type.toLowerCase()}`)} on firmware ${fs[0]!.firmware} across ${plural(rooms.length, "room")}`,
      rooms,
      evidence: fs.map((f) => `${f.room}: ${f.name}, ${f.status}`),
      check: `Firmware ${fs[0]!.firmware} is the common factor: check its release notes and whether a newer or older version fixes it, in one room first.`,
    });
  }

  // 4. The same kind of problem in several rooms, when no group above already names those rooms.
  const byKind = new Map<string, { room: string; text: string; level: FindingLevel }[]>();
  for (const d of read)
    for (const f of d.findings) {
      if (f.subject === "Room computer offline") continue;
      const kind = kindOf(f.subject);
      if (!kind) continue;
      const list = byKind.get(kind) ?? [];
      if (!list.some((x) => x.room === d.room!.name)) list.push({ room: d.room!.name, text: f.subject, level: f.level });
      byKind.set(kind, list);
    }
  for (const [kind, list] of byKind) {
    const rooms = list.map((x) => x.room);
    // Skip only when an earlier group already covers the same kind of problem in exactly these rooms.
    if (rooms.length < 2 || patterns.some((p) => sameSet(p.rooms, rooms) && kindOf(p.title) === kind)) continue;
    patterns.push({
      kind: "same-problem",
      level: list.some((x) => x.level === "critical") ? "critical" : "warning",
      title: `${kind[0]!.toUpperCase()}${kind.slice(1)} problems in ${plural(rooms.length, "room")}`,
      rooms,
      evidence: list.map((x) => `${x.room}: ${x.text}`),
      check: `Different hardware, same symptom: check what these rooms share (network segment, recent change, Zoom Rooms version) before treating them one by one.`,
    });
  }

  const order: Record<PatternKind, number> = { "location-offline": 0, "same-model": 1, "same-firmware": 2, "same-problem": 3 };
  return patterns.sort((a, b) => (a.level === b.level ? 0 : a.level === "critical" ? -1 : 1) || order[a.kind] - order[b.kind] || b.rooms.length - a.rooms.length);
};

export const diagnoseRooms = async (client: ZoomRoomsClient, now = Date.now(), limit = ROOMS_DETAIL_LIMIT): Promise<RoomsDiagnosis> => {
  let rooms: any[];
  try {
    const all = (await client.listRooms()) as any;
    rooms = (Array.isArray(all) ? all : arr(all?.rooms)).filter((r) => r !== null && typeof r === "object");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { summary: `Could not read the room list, so the rooms could not be diagnosed: ${reason}. This is not an all-clear.`, view: "rooms-diagnosis", total: 0, needAttention: 0, patterns: [], rooms: [], notDiagnosed: [], couldNotCheck: [`Room list: ${reason}`], allClear: false };
  }

  const couldNotCheck: string[] = [];
  for (const r of rooms.filter((r) => !levelOf(r) && !/^healthy$/i.test(str(r.health))))
    couldNotCheck.push(`${str(r.name) || str(r.id)}: health is "${str(r.health) || "not reported"}", so it could not be classed as healthy.`);
  // Offline first, then critical, then warning: the same order as get_rooms_needing_attention.
  const problems = rooms
    .map((r) => ({ r, level: levelOf(r) }))
    .filter((x) => x.level !== null)
    .sort((a, b) => (a.level === b.level ? Number(str(b.r.status).toLowerCase() === "offline") - Number(str(a.r.status).toLowerCase() === "offline") : a.level === "critical" ? -1 : 1));

  const diagnoses = await Promise.all(problems.slice(0, limit).map(({ r }) => diagnoseRoom(client, str(r.id), now, r)));
  const notDiagnosed = problems.slice(limit).map(({ r }) => str(r.name) || str(r.id));
  const patterns = findPatterns(diagnoses);

  const rows: RoomRow[] = diagnoses.map((d, i) => {
    const r = problems[i]!.r;
    if (!d.room) return { id: str(r.id), name: str(r.name) || str(r.id), level: "could_not_check", findings: 0, top: null, couldNotCheck: d.couldNotCheck.length };
    const level: FindingLevel = d.findings.some((f) => f.level === "critical") ? "critical" : "warning";
    return { id: d.room.id, name: d.room.name, level, findings: d.findings.length, top: d.findings[0]?.subject ?? null, couldNotCheck: d.couldNotCheck.length };
  });
  for (const d of diagnoses) if (d.couldNotCheck.length) couldNotCheck.push(...d.couldNotCheck.map((c) => `${d.room?.name ?? "A room"}: ${c}`));

  const allClear = rooms.length > 0 && problems.length === 0 && couldNotCheck.length === 0;
  const lines: string[] = [];
  if (rooms.length === 0) lines.push("The account has no rooms to diagnose. This is not an all-clear: there is nothing to check.");
  else if (allClear) lines.push(`All ${rooms.length} rooms are healthy and none is offline.`);
  else if (problems.length === 0) lines.push("No room reports a problem, but not everything could be read, so this is not an all-clear.");
  else {
    lines.push(
      `${problems.length} of ${rooms.length} rooms need attention. ${
        patterns.length
          ? `${plural(patterns.length, "shared cause")} found; start with: ${patterns[0]!.title}.`
          : "No shared cause across the rooms: each problem looks local, so work down the list."
      }`,
    );
    if (patterns.length) {
      lines.push("", "Shared causes, worst first:");
      patterns.forEach((p, i) => lines.push(`${i + 1}. [${p.level}] ${p.title}`, ...p.evidence.map((e) => `   - ${e}`), `   Check: ${p.check}`));
    }
    lines.push("", "Per room (diagnose_room with its id for the full answer):");
    for (const row of rows)
      lines.push(`- ${row.name} (id ${row.id}): ${row.level === "could_not_check" ? "could not be read" : `${row.level}, ${plural(row.findings, "finding")}${row.top ? `; first: ${row.top}` : ""}`}${row.level !== "could_not_check" && row.couldNotCheck ? `; ${row.couldNotCheck} part${row.couldNotCheck === 1 ? "" : "s"} could not be read` : ""}`);
    if (notDiagnosed.length) lines.push(`${plural(notDiagnosed.length, "more problem room")} not diagnosed in this call: ${names(notDiagnosed, 10)}.`);
  }
  if (couldNotCheck.length) lines.push("", "Could not check:", ...couldNotCheck.map((c) => `- ${c}`));
  return { summary: lines.join("\n"), view: "rooms-diagnosis", total: rooms.length, needAttention: problems.length, patterns, rooms: rows, notDiagnosed, couldNotCheck, allClear };
};
