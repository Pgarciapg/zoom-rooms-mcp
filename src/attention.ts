// "Which rooms need attention right now?" (2026-11-17). The other tools return raw Zoom data; this one rolls the account
// up: problem rooms worst first, each with its open issues, the devices that are not online, whether a meeting is running
// in it right now, and a plain next step. Read-only: it only calls listRooms, getRoom and getRoomDevices, plus listLocations to name a place
// Zoom gives only as a location code. Anything it
// could not read is listed apart, and it never reports all clear while something could not be read.
import { alertsNote, devicesClearLine } from "./all-clear.ts";
import type { ZoomRoomsClient } from "./client.ts";
import { PlaceNamer } from "./locations.ts";
import { allocateMoveTo, cleanName, sizeWords, freeRoomsIn, lookUpFits, readCapacity, type RoomFit } from "./move-to.ts";
import { ago } from "./ago.ts";
import { deviceName } from "./device-fields.ts";

/** A room computer that is up (same rule as diagnose.ts; kept here so the two modules do not import each other). */
const UP_STATUS = /^(available|online|in ?meeting|idle|connected)$/i;

export type Level = "critical" | "warning";

export interface RoomIssue {
  issue: string;
  severity: string;
  since: string | null;
  /** How long it has been open ("about 3 h"), when `since` is a readable past time. Attention list only. */
  age?: string | null;
}

export interface AttentionRoom {
  id: string;
  name: string;
  level: Level;
  status: string;
  health: string;
  where: string | null;
  inMeeting: boolean;
  lastOnline: string | null;
  issues: RoomIssue[];
  /** Devices whose status is not Online or Connected, e.g. "Logitech Rally (Camera): Disconnected". */
  devices: string[];
  next: string;
  /** For a room in a meeting: up to three rooms in the same Zoom location that are free and healthy now, its own
   * pick first; no two meetings are given the same first room (see move-to.ts). */
  moveTo: { id: string; name: string }[];
  /** When every free room nearby was already suggested for a worse room above: which rooms, and for whom. */
  moveToNote: string | null;
  /** The seats of the first suggested room (moveTo[0]) from Zoom's room profile. This list has no meeting size, so the
   * fit is always "not_compared"; diagnose_room compares when given one. Null when nothing is suggested. */
  moveToSize: RoomFit | null;
  /** This room's own seats from its Zoom profile (basic.capacity), or null. */
  seats: number | null;
}

export interface Attention {
  summary: string;
  total: number;
  needAttention: number;
  counts: Record<Level, number>;
  rooms: AttentionRoom[];
  /** Problem rooms past the detail limit: counted and named, not read in detail. */
  notReadInDetail: string[];
  couldNotCheck: string[];
  allClear: boolean;
  /** Every room up and every device read online; the only gap is that Zoom's room profile gave no alerts for some rooms. */
  devicesClear: boolean;
  /** Why any place shows a Zoom location code instead of a name, or null. Never affects allClear. */
  placeNote: string | null;
}

/** Problem rooms read in detail per call; the rest are still counted and named. */
export const DETAIL_LIMIT = 15;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const roomsOf = (data: unknown): any[] => (Array.isArray(data) ? data : arr((data as any)?.rooms));
const OK_DEVICE = /^(online|connected|available|in ?use)$/i;

export const levelOf = (room: any): Level | null => {
  const health = str(room.health).toLowerCase();
  const status = str(room.status).toLowerCase();
  if (health === "critical" || status === "offline") return "critical";
  if (health === "warning") return "warning";
  return null;
};

/** Plain next step from the open issue and device text. The most specific rule wins. */
export const nextStep = (room: Pick<AttentionRoom, "status" | "issues" | "devices" | "lastOnline">, now?: number): string => {
  // An offline room computer comes first: nothing else in the room can be checked until it is back.
  const offline = room.status.toLowerCase() === "offline";
  const specific = deviceStep(room);
  // How long, by diagnose_room's rule; no age when the time is unreadable or later than now.
  const gone = now === undefined ? null : ago(room.lastOnline, now);
  if (offline)
    return `The room computer is offline${room.lastOnline ? ` (last online ${room.lastOnline}${gone ? `, ${gone} ago` : ""})` : ""}: check its power and network, then restart Zoom Rooms.${specific ? ` Then: ${specific}` : ""}`;
  return specific ?? "Open the room in the Zoom admin portal and read its full alert.";
};

export const deviceStep = (room: Pick<AttentionRoom, "issues" | "devices">): string | null => {
  const text = [...room.issues.map((i) => i.issue), ...room.devices].join(" ").toLowerCase();
  if (/camera/.test(text) && /disconnect|offline|not detected/.test(text))
    return "Reseat the camera's USB (or network) cable at the room computer, then restart the Zoom Rooms app.";
  if (/(mic|microphone)/.test(text) && /offline|disconnect/.test(text)) return "Check the microphone's network or PoE port, then confirm it is selected in the room's Zoom Rooms settings.";
  if (/(speaker|audio)/.test(text) && /offline|disconnect/.test(text)) return "Check the speaker's cable and power, then reselect it in the room's audio settings.";
  if (/cpu|memory|overload|slow/.test(text)) return "Restart the controller. If it comes back, check for a firmware or Zoom Rooms update.";
  if (/display|hdmi|screen/.test(text) && /offline|disconnect|no signal/.test(text)) return "Check the display's power and HDMI, and that it is on the right input.";
  if (/controller|touch/.test(text) && /offline|disconnect/.test(text)) return "Check the controller's network cable or Wi-Fi, then re-pair it with the room.";
  if (/firmware|update/.test(text)) return "Update the device firmware from the Zoom admin portal.";
  return null;
};

export const roomsNeedingAttention = async (client: ZoomRoomsClient, limit = DETAIL_LIMIT, now = Date.now()): Promise<Attention> => {
  const couldNotCheck: string[] = [];
  let rooms: any[];
  try {
    const list = await client.listRooms();
    rooms = roomsOf(list);
    if (str((list as any)?.next_page_token)) couldNotCheck.push("Room list: Zoom has more pages of rooms than were read.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { summary: `Could not read the room list: ${reason}`, total: 0, needAttention: 0, counts: { critical: 0, warning: 0 }, rooms: [], notReadInDetail: [], couldNotCheck: [`Room list: ${reason}`], allClear: false, devicesClear: false, placeNote: null };
  }

  const unknownHealth = rooms.filter((r) => !levelOf(r) && !/^healthy$/i.test(str(r.health)));

  const problems = rooms
    .map((r) => ({ r, level: levelOf(r) }))
    .filter((x): x is { r: any; level: Level } => x.level !== null)
    .sort((a, b) => (a.level === b.level ? Number(str(b.r.status).toLowerCase() === "offline") - Number(str(a.r.status).toLowerCase() === "offline") : a.level === "critical" ? -1 : 1));

  const places = new PlaceNamer(client);
  // How each room's own reads went, for the no-health rooms read below.
  const readOk = new Map<string, { clean: boolean; noAlerts: boolean }>();
  const readOne = async ({ r, level }: { r: any; level: Level }): Promise<AttentionRoom> => {
      const id = str(r.id);
      const name = str(r.name) || id;
      let detail: any = null;
      let devices: any[] = [];
      try {
        detail = await client.getRoom(id);
      } catch (error) {
        couldNotCheck.push(`${name} details: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        devices = arr(((await client.getRoomDevices(id)) as any)?.devices);
      } catch (error) {
        couldNotCheck.push(`${name} devices: ${error instanceof Error ? error.message : String(error)}`);
      }
      const loc = detail?.location;
      const fromDetail = loc && typeof loc === "object" ? [str(loc.building), str(loc.floor)].filter(Boolean).join(", ") : typeof loc === "string" ? str(loc) : "";
      // A location code gets its name from Zoom's location tree (read once per call, only when needed).
      const code = str(detail?.location_id) || str(r.location_id);
      const where = fromDetail || (code ? await places.name(code) : null);
      readOk.set(id, {
        // The profile's own status and health count too (Sonnet review, 11/26): a list row can lag behind it.
        clean:
          !!detail &&
          typeof detail === "object" &&
          devices.length > 0 &&
          (detail.issues == null || Array.isArray(detail.issues)) &&
          (!str(detail.status) || UP_STATUS.test(str(detail.status))) &&
          (!str(detail.health) || /^healthy$/i.test(str(detail.health))),
        noAlerts: !!detail && typeof detail === "object" && !("issues" in detail),
      });
      const issues: RoomIssue[] = arr(detail?.issues).map((i) => ({ issue: str(i.issue ?? i.description ?? i.name), severity: str(i.severity), since: i.since ? str(i.since) : null, age: i.since ? ago(str(i.since), now) : null }));
      const bad = devices.filter((d) => !OK_DEVICE.test(str(d.status))).map((d) => `${deviceName(d) || "Device"} (${str(d.device_type) || "device"}): ${str(d.status) || "no status"}`);
      const base = { status: str(r.status), issues, devices: bad, lastOnline: detail?.last_online ? str(detail.last_online) : null };
      // Exactly "In Meeting" (any case or spacing): "Not in meeting" is not a meeting.
      const inMeeting = /^\s*in ?meeting\s*$/i.test(str(r.status));
      // Where the meeting can go, from the room list already read (no extra Zoom call).
      const candidates = inMeeting
        ? freeRoomsIn(rooms, new Set([id, str(r.room_id), str(detail?.room_id)].filter(Boolean)), new Set([str(detail?.location_id), str(r.location_id)].filter(Boolean)))
        : [];
      return { id, name, level, health: str(r.health), where, inMeeting, ...base, next: nextStep(base, now), moveTo: candidates, moveToNote: null, moveToSize: null as RoomFit | null, seats: readCapacity(detail) };
  };
  const detailed = await Promise.all(problems.slice(0, limit).map(readOne));
  // Zoom's documented room list has no health field (Codex review, 11/25): an up room with none could still have a
  // device down or an open issue, so it is read too, with whatever room is left under the limit.
  const quiet = rooms.filter((r) => !levelOf(r) && !str(r.health) && UP_STATUS.test(str(r.status)) && str(r.id));
  const spare = Math.max(0, limit - detailed.length);
  let alertsUnread = 0;
  for (const room of await Promise.all(quiet.slice(0, spare).map((r) => readOne({ r, level: "warning" })))) {
    if (!room.devices.length && !room.issues.length) {
      // Read cleanly with every device online: its health comes from that reading (11/26: allClear was never true on
      // a real account). A profile without alerts is named once below; a failed read keeps it unclassed.
      const how = readOk.get(room.id);
      const q = quiet.find((x) => str(x.id) === room.id);
      if (how?.clean && q && unknownHealth.includes(q)) {
        unknownHealth.splice(unknownHealth.indexOf(q), 1);
        if (how.noAlerts) alertsUnread++;
      }
      continue;
    }
    if (room.issues.some((i) => /^critical$/i.test(i.severity))) room.level = "critical";
    const r = quiet.find((q) => str(q.id) === room.id)!;
    problems.push({ r, level: room.level });
    detailed.push(room);
    if (unknownHealth.includes(r)) unknownHealth.splice(unknownHealth.indexOf(r), 1);
  }
  if (quiet.length > spare) couldNotCheck.push(`${quiet.length - spare} more ${quiet.length - spare === 1 ? "room" : "rooms"} with no health from Zoom ${quiet.length - spare === 1 ? "was" : "were"} not read (past the limit of ${limit} rooms read per call).`);
  if (alertsUnread) couldNotCheck.push(alertsNote(alertsUnread));
  for (const r of unknownHealth) couldNotCheck.push(`${str(r.name) || str(r.id)}: health is "${str(r.health) || "not reported"}", so it could not be classed as healthy.`);
  // Within a level: offline first, then the oldest open issue first.
  const firstSince = (room: AttentionRoom) => room.issues.map((i) => i.since ?? "~").sort()[0] ?? "~";
  detailed.sort((a, b) => (a.level === b.level ? Number(b.status.toLowerCase() === "offline") - Number(a.status.toLowerCase() === "offline") || firstSince(a).localeCompare(firstSince(b)) : a.level === "critical" ? -1 : 1));
  // Several meetings in the same place: each gets a different free room, worst room first (same order as the list).
  allocateMoveTo(detailed.map((room) => ({ name: room.name, candidates: room.moveTo }))).forEach((m, i) => Object.assign(detailed[i]!, m));
  // The seats of each meeting's first suggestion (one profile read each; picks never repeat across meetings).
  const picked = detailed.filter((room) => room.moveTo.length);
  (await lookUpFits(client, picked.map((room) => room.moveTo[0]!.id), null)).forEach((f, i) => (picked[i]!.moveToSize = f));

  const counts = { critical: problems.filter((p) => p.level === "critical").length, warning: problems.filter((p) => p.level === "warning").length };
  const hidden = problems.length - detailed.length;
  const notReadInDetail = problems.slice(limit).map((p) => str(p.r.name) || str(p.r.id));
  const allClear = problems.length === 0 && couldNotCheck.length === 0;
  const devicesClear = !allClear && rooms.length > 0 && problems.length === 0 && alertsUnread > 0 && couldNotCheck.length === 1 && rooms.every((r) => UP_STATUS.test(str(r.status)));
  const lines: string[] = [];
  if (allClear) lines.push(`All ${rooms.length} rooms are healthy and none is offline.`);
  else if (devicesClear) lines.push(devicesClearLine(rooms.length, alertsUnread));
  else if (problems.length === 0) lines.push(`No room reports a problem, but not everything could be read, so this is not an all-clear.`);
  else {
    const parts = [counts.critical ? `${counts.critical} critical` : "", counts.warning ? `${counts.warning} warning` : ""].filter(Boolean).join(", ");
    lines.push(`${problems.length} of ${rooms.length} rooms need attention: ${parts}.`);
    detailed.forEach((room, i) => {
      // Two problem rooms with one name also carry Zoom's room id, the label diagnose_room uses for them.
      const twin = detailed.filter((o) => o.name.toLowerCase() === room.name.toLowerCase()).length > 1;
      const place = [room.where, twin ? `Zoom room ${cleanName(room.id)}` : null].filter(Boolean).join(", ");
      const head = `${i + 1}. [${room.level === "critical" ? "Critical" : "Warning"}] ${room.name}${place ? ` (${place})` : ""}: ${room.status}${room.inMeeting ? `, in a meeting right now (fix after it ends${room.moveTo.length ? `, or move it to ${room.moveTo[0]!.name}${sizeWords(room)}, free now in the same Zoom location` : room.moveToNote ? `; ${room.moveToNote}` : ""})` : ""}.`;
      lines.push(head);
      for (const issue of room.issues) lines.push(`   Issue: ${issue.issue}${issue.since ? ` (since ${issue.since}${issue.age ? `, ${issue.age} ago` : ""})` : ""}.`);
      if (room.devices.length) lines.push(`   Devices not online: ${room.devices.join("; ")}.`);
      lines.push(`   Next: ${room.next}`);
    });
    if (hidden > 0) lines.push(`${hidden} more problem room${hidden === 1 ? "" : "s"} not read in detail: ${notReadInDetail.join(", ")}.`);
    lines.push("For one room's full answer, call diagnose_room with its id.");
  }
  if (couldNotCheck.length) lines.push("", "Could not check:", ...couldNotCheck.map((c) => `- ${c}`));
  const placeNote = places.note();
  if (placeNote) lines.push("", placeNote);
  return { summary: lines.join("\n"), total: rooms.length, needAttention: problems.length, counts, rooms: detailed, notReadInDetail, couldNotCheck, allClear, devicesClear, placeNote };
};
