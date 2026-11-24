// "Why is this room unhappy, and what do I check first?" (2026-11-20). get_rooms_needing_attention ranks the account;
// this one answers for a single room: every problem it can see (the room computer, each open issue, each device that is
// not online), with the open issue and the failing device joined into one finding when they describe the same thing,
// worst first, each with one check. Read-only: it only calls getRoom and getRoomDevices, plus listRooms when the room
// detail does not carry its status or health, and listLocations to name a place Zoom gives only as a location code. Anything it could not read is listed apart, and it never reports all
// clear while something could not be read.
import { deviceStep, levelOf, type RoomIssue } from "./attention.ts";
import { PlaceNamer } from "./locations.ts";
import { besideRoom, cleanName, FIT_LOOKUP_LIMIT, readCapacity, FIT_ORDER, freeRoomsIn, lookUpFits, MOVE_TO_LIMIT, readAttendees, type RoomFit } from "./move-to.ts";
import type { ZoomRoomsClient } from "./client.ts";
import { ago } from "./ago.ts";

export type FindingLevel = "critical" | "warning";

export interface RoomFinding {
  level: FindingLevel;
  /** What is wrong, e.g. "Room computer offline" or "Logitech Rally (Camera): Disconnected". */
  subject: string;
  /** The evidence in plain words: the open issue and/or the device status it rests on. */
  detail: string;
  since: string | null;
  check: string;
}

export interface DeviceRow {
  name: string;
  type: string;
  status: string;
  firmware: string | null;
  ok: boolean;
}

export interface RoomFacts {
  id: string;
  name: string;
  where: string | null;
  /** Lowercased place key for grouping rooms: building and floor (both known), or a location id or text. Null if partial or missing. */
  placeKey: string | null;
  status: string;
  health: string;
  inMeeting: boolean;
  lastOnline: string | null;
  /** This room's seats from its Zoom profile (basic.capacity), or null. */
  seats: number | null;
}

export interface RoomDiagnosis {
  summary: string;
  view: "room-diagnosis";
  room: RoomFacts | null;
  findings: RoomFinding[];
  devices: DeviceRow[];
  couldNotCheck: string[];
  allClear: boolean;
  /** Why this room's place shows a Zoom location code instead of a name, or null. Never affects allClear. */
  placeNote: string | null;
  /**
   * Where a meeting can go: other rooms in the same Zoom location that are healthy and free right now (up to three,
   * `more` counts the rest). Null when not looked for (the room has no problem, or the caller did not ask). `note` says
   * why the list is empty or may be incomplete. Never affects allClear.
   */
  moveTo: { rooms: { id: string; name: string }[]; more: number; note: string | null } | null;
  /**
   * The seats of each room in `moveTo.rooms` (same order), from Zoom's room profile, and whether it fits `attendees`
   * (the meeting size the caller gave, or null). With a meeting size, rooms that fit are named first. Null when no free
   * room was named. Never affects allClear.
   */
  roomSizes: { attendees: number | null; rooms: RoomFit[]; note: string | null } | null;
}

export { MOVE_TO_LIMIT } from "./move-to.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const OK_DEVICE = /^(online|connected|available|in ?use)$/i;
const KNOWN_HEALTH = /^(healthy|warning|critical)$/i;
/** Room computer states that mean it is up. Offline is a finding; anything else could not be classed. */
export const UP_STATUS = /^(available|online|in ?meeting|idle|connected)$/i;
/** Words that say something has stopped working. An issue joins a failing device only when it says one of these. */
export const FAILURE = /offline|disconnect|not detected|no signal|not responding|unreachable|down\b|fail|error|lost/i;
const RESOLVED = /^(resolved|closed|cleared|fixed)$/i;

/** Device kinds an issue text can name, keyed by the words that name them. */
const KINDS: [RegExp, RegExp][] = [
  [/camera/i, /camera/i],
  [/\b(mic|microphone)s?\b/i, /mic/i],
  [/speaker|audio/i, /speaker|audio/i],
  [/display|screen|hdmi|tv\b/i, /display|screen|tv/i],
  [/controller|touch ?panel/i, /controller|touch/i],
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The issue names this device itself: its full name as whole words, and the name is long enough to mean something. */
const namesDevice = (issue: string, device: DeviceRow): boolean =>
  device.name.length >= 4 && device.name !== "Device" && new RegExp(`(^|\\W)${escape(device.name)}($|\\W)`, "i").test(issue);
/** The issue says this kind of device has stopped working (a firmware or echo note does not explain an outage). */
const namesKind = (issue: string, device: DeviceRow): boolean =>
  FAILURE.test(issue) && KINDS.some(([inIssue, inType]) => inIssue.test(issue) && inType.test(`${device.type} ${device.name}`));

const levelOfSeverity = (severity: string): FindingLevel => (/crit|high|severe|error|major|\bp1\b/i.test(severity) ? "critical" : "warning");

export { ago } from "./ago.ts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const GENERIC_DEVICE_CHECK = "Check the device's power and cable, then look at it in the Zoom admin portal.";
const GENERIC_ISSUE_CHECK = "Open the room in the Zoom admin portal and read its full alert.";

/** Pass `listed` (the room's row from listRooms) when you already have it, so the room list is not read again. */
export const diagnoseRoom = async (client: ZoomRoomsClient, roomId: string, now = Date.now(), listedRow?: unknown, places = new PlaceNamer(client), opts: { moveTo?: boolean; attendees?: number } = {}): Promise<RoomDiagnosis> => {
  const couldNotCheck: string[] = [];
  let detail: any = null;
  let deviceData: unknown[] | null = null;
  try {
    detail = await client.getRoom(roomId);
  } catch (error) {
    couldNotCheck.push(`Room details: ${msg(error)}`);
  }
  try {
    const got = (await client.getRoomDevices(roomId)) as any;
    const list = Array.isArray(got) ? got : got?.devices;
    if (list != null && !Array.isArray(list)) couldNotCheck.push("Devices: Zoom answered in an unexpected shape, so none could be checked.");
    else deviceData = arr(list);
  } catch (error) {
    couldNotCheck.push(`Devices: ${msg(error)}`);
  }

  // The room's status and health come from its detail; when the detail lacks them, read them from the room list.
  let listed: any = isObj(listedRow) ? listedRow : null;
  // The room list, when it was read here (kept so looking for a free room does not read it again).
  let roomList: { rooms: any[]; partial: boolean } | null = null;
  let roomListError: string | null = null;
  if (!listed && (!str(detail?.status) || !str(detail?.health))) {
    try {
      const all = (await client.listRooms()) as any;
      const rooms = Array.isArray(all) ? all : arr(all?.rooms);
      roomList = { rooms, partial: typeof all?.next_page_token === "string" && !!all.next_page_token };
      listed = rooms.find((r) => isObj(r) && (str(r.id) === roomId || str(r.room_id) === roomId)) ?? null;
      if (!listed && detail) couldNotCheck.push(`Status and health: room ${roomId} is not in the room list.`);
    } catch (error) {
      roomListError = msg(error);
      couldNotCheck.push(`Status and health (room list): ${msg(error)}`);
    }
  }

  if (!detail && !listed) {
    const summary = `Could not check room ${roomId}: ${couldNotCheck[0]?.replace(/^[^:]+: /, "") ?? "it did not answer"}. This is not an all-clear.`;
    return { summary, view: "room-diagnosis", room: null, findings: [], devices: [], couldNotCheck, allClear: false, placeNote: null, moveTo: null, roomSizes: null };
  }

  const loc = detail?.location;
  let placeNote: string | null = null;
  const room: RoomFacts = {
    id: str(detail?.id) || str(listed?.id) || roomId,
    name: str(detail?.name) || str(listed?.name) || roomId,
    where: null,
    placeKey: null,
    status: str(detail?.status) || str(listed?.status),
    health: str(detail?.health) || str(listed?.health),
    inMeeting: false,
    lastOnline: detail?.last_online ? str(detail.last_online) : null,
    seats: readCapacity(detail),
  };
  room.inMeeting = /^\s*in ?meeting\s*$/i.test(room.status);
  // Where the room is. A building without a floor (or the reverse) is shown but never used to group rooms.
  const building = isObj(loc) ? str(loc.building) : "";
  const floorName = isObj(loc) ? str(loc.floor) : "";
  const locId = str(detail?.location_id) || str(listed?.location_id);
  const locText = typeof loc === "string" ? str(loc) : "";
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
  if (building && floorName) {
    room.where = `${building}, ${floorName}`;
    room.placeKey = key(room.where);
  } else if (locText || locId) {
    // A location code gets its name from Zoom's location tree; the group key stays the code.
    room.placeKey = key(locText || locId);
    if (locText) room.where = locText;
    else {
      const label = await places.lookup(locId);
      room.where = label.text;
      // Only this room's own place: a namer shared across rooms keeps the call-wide note for diagnose_rooms.
      if (label.issue) placeNote = places.note([locId]);
    }
  } else room.where = [building, floorName].filter(Boolean).join(", ") || null;
  const offline = room.status.toLowerCase() === "offline";
  if (!offline && !UP_STATUS.test(room.status)) couldNotCheck.push(`Status: "${room.status || "not reported"}", so the room computer could not be classed as up.`);
  if (!KNOWN_HEALTH.test(room.health)) couldNotCheck.push(`Health: "${room.health || "not reported"}", so the room could not be classed as healthy.`);

  const deviceRows = (deviceData ?? []).filter(isObj);
  if (deviceData && deviceRows.length < deviceData.length) couldNotCheck.push(`Devices: ${plural(deviceData.length - deviceRows.length, "entry")} in the device list could not be read.`.replace("entrys", "entries"));
  const devices: DeviceRow[] = deviceRows.map((d) => {
    const status = str(d.status) || "no status";
    return { name: str(d.name) || "Device", type: str(d.device_type) || "device", status, firmware: d.firmware ? str(d.firmware) : null, ok: OK_DEVICE.test(status) };
  });
  // An empty device list usually means Zoom could not see the devices, not that the room has none.
  if (deviceData && deviceData.length === 0) couldNotCheck.push("Devices: Zoom listed no devices for this room, so none could be checked.");
  const rawIssues = detail?.issues;
  if (detail && isObj(detail) && !("issues" in detail)) couldNotCheck.push("Open issues: the room detail has no issues list, so open issues could not be read.");
  if (rawIssues != null && !Array.isArray(rawIssues)) couldNotCheck.push("Open issues: Zoom answered in an unexpected shape, so they could not be read.");
  const issueRows = arr(rawIssues);
  if (issueRows.some((i) => !isObj(i))) couldNotCheck.push(`Open issues: ${plural(issueRows.filter((i) => !isObj(i)).length, "entry")} could not be read.`.replace("entrys", "entries"));
  const issues: RoomIssue[] = issueRows
    .filter(isObj)
    .filter((i) => !RESOLVED.test(str(i.status)))
    .map((i) => ({ issue: str(i.issue ?? i.description ?? i.name ?? i.alert ?? i.message ?? i.title ?? i.text), severity: str(i.severity), since: i.since ? str(i.since) : null }));

  const findings: RoomFinding[] = [];
  if (offline) {
    const gone = ago(room.lastOnline, now);
    findings.push({
      level: "critical",
      subject: "Room computer offline",
      detail: `Zoom sees the room computer as offline${room.lastOnline ? ` (last online ${room.lastOnline}${gone ? `, ${gone} ago` : ""})` : ""}. Nothing else in the room can be checked until it is back.`,
      since: room.lastOnline,
      check: "Check the room computer's power and network, then restart the Zoom Rooms app.",
    });
  }

  // Each failing device, joined with the open issue that describes it (one finding, not two).
  const usedIssues = new Set<number>();
  const failing = devices.filter((d) => !d.ok);
  // An issue that names one failing device by name is kept for that device, not given to another of the same kind.
  const failingNamedElsewhere = (issue: string, device: DeviceRow) => failing.some((d) => d !== device && namesDevice(issue, d));
  for (const device of failing) {
    // Pass 1: an issue that names this device. Pass 2: an issue that says this kind of device stopped working.
    const free = (i: number) => !usedIssues.has(i);
    let matchIdx = issues.findIndex((issue, i) => free(i) && namesDevice(issue.issue, device));
    if (matchIdx < 0) matchIdx = issues.findIndex((issue, i) => free(i) && namesKind(issue.issue, device) && !failingNamedElsewhere(issue.issue, device));
    const match = matchIdx >= 0 ? issues[matchIdx]! : null;
    if (match) usedIssues.add(matchIdx);
    const label = `${device.name} (${device.type}): ${device.status}`;
    const parts = [match ? `Open issue: ${match.issue}${match.since ? ` (since ${match.since})` : ""}.` : "No open issue names it; the device list shows it is not online."];
    if (offline) parts.push("The room computer is offline too, so this may clear once it is back.");
    findings.push({
      level: match ? levelOfSeverity(match.severity) : "warning",
      subject: label,
      detail: parts.join(" "),
      since: match?.since ?? null,
      check: deviceStep({ issues: match ? [match] : [], devices: [label] }) ?? GENERIC_DEVICE_CHECK,
    });
  }

  // Open issues no failing device explains.
  issues.forEach((issue, i) => {
    if (usedIssues.has(i)) return;
    findings.push({
      level: levelOfSeverity(issue.severity),
      subject: issue.issue || "Unnamed issue",
      detail: `Open issue${issue.severity ? ` (${issue.severity})` : ""}${issue.since ? `, since ${issue.since}` : ""}.`,
      since: issue.since,
      check: deviceStep({ issues: [issue], devices: [] }) ?? GENERIC_ISSUE_CHECK,
    });
  });

  // Zoom says the room is unhealthy but shows nothing that explains it.
  if (findings.length === 0 && /^(warning|critical)$/i.test(room.health)) {
    findings.push({
      level: room.health.toLowerCase() === "critical" ? "critical" : "warning",
      subject: `Health is ${room.health} with no open issue`,
      detail: `Zoom reports ${room.health} health, but the room has no open issue and every device that could be read is online.`,
      since: null,
      check: GENERIC_ISSUE_CHECK,
    });
  }

  // Worst first: the offline room computer, then critical, then warning; oldest first within a level.
  const rank = (f: RoomFinding) => (f.subject === "Room computer offline" ? 0 : f.level === "critical" ? 1 : 2);
  findings.sort((a, b) => rank(a) - rank(b) || (a.since ?? "~").localeCompare(b.since ?? "~"));

  const allClear = findings.length === 0 && couldNotCheck.length === 0;

  // Where a meeting can go. Only rooms with the same Zoom location code (never a guess across floors), up, free and
  // healthy by Zoom's own list. A list that could not be read says so; it never reads as "none free".
  let moveTo: RoomDiagnosis["moveTo"] = null;
  let roomSizes: RoomDiagnosis["roomSizes"] = null;
  const attendees = readAttendees(opts.attendees);
  // With a meeting size: true when none of the free rooms whose size was read fits it (set with the rooms below).
  let noneFits: { checked: number; unread: number; largest: { name: string; capacity: number } | null } | null = null;
  if (opts.moveTo && findings.length > 0) {
    try {
      // A room list that already failed here is not read again.
      if (roomListError) throw new Error(roomListError);
      if (!roomList) {
        const all = (await client.listRooms()) as any;
        roomList = { rooms: Array.isArray(all) ? all : arr(all?.rooms), partial: typeof all?.next_page_token === "string" && !!all.next_page_token };
      }
      const self = new Set([roomId, room.id, str(detail?.room_id), str(listed?.room_id)].filter(Boolean));
      // The room's location codes: from its detail and its row in the list (a detail with building and floor text often
      // carries no code). Either one counts, so a detail and a list that disagree never hide a free room.
      const ownRow = roomList.rooms.find((r) => isObj(r) && (self.has(str(r.id)) || self.has(str(r.room_id))));
      const mine = new Set([locId, str(ownRow?.location_id), str(listed?.location_id)].filter(Boolean));
      if (!mine.size)
        moveTo = { rooms: [], more: 0, note: roomList.partial && !ownRow ? "This room's location was not in the part of Zoom's room list that was read, so no room nearby could be suggested." : "Zoom gives no location for this room, so no room nearby could be suggested." };
      else {
        const free = freeRoomsIn(roomList.rooms, self, mine);
        const partial = roomList.partial ? "Only part of Zoom's room list was read, so there may be more." : null;
        // Other problem rooms here in a meeting may be given these free rooms first by get_rooms_needing_attention
        // (each meeting gets a different one there), so this answer says so rather than contradict it.
        const rivals = !room.inMeeting || !free.length ? [] : roomList.rooms
          .filter((r): r is Record<string, unknown> => isObj(r) && !self.has(str(r.id)) && !self.has(str(r.room_id)))
          .filter((r) => mine.has(str(r.location_id)) && /^\s*in ?meeting\s*$/i.test(str(r.status)) && levelOf(r) !== null)
          .map((r) => ({ id: str(r.id) || str(r.room_id), name: cleanName(str(r.name)) || cleanName(str(r.id) || str(r.room_id)) || "another room" }))
          // The same room listed twice is one rival.
          .filter((r, i, all) => !r.id || all.findIndex((o) => o.id === r.id) === i)
          // Two problem rooms with one name ("Lobby, Lobby"), or one named like this room, carry Zoom's room id.
          .map((r, _i, all) => {
            const same = all.filter((o) => o.name.toLowerCase() === r.name.toLowerCase()).length > 1 || r.name.toLowerCase() === cleanName(room.name).toLowerCase();
            return !same ? r.name : r.id ? `${r.name} (Zoom room ${cleanName(r.id)})` : `${r.name} (no Zoom id)`;
          });
        const shared = rivals.length
          ? `${rivals.length === 1 ? `Another problem room here, ${rivals[0]}, is` : `${rivals.length} other problem rooms here (${rivals.slice(0, MOVE_TO_LIMIT).join(", ")}${rivals.length > MOVE_TO_LIMIT ? ", ..." : ""}) are`} also in a meeting; get_rooms_needing_attention gives each meeting a different free room.`
          : null;
        // Room sizes. Without a meeting size, only the named rooms are read. With one, up to FIT_LOOKUP_LIMIT free rooms
        // are read and the ones that fit are named first (then unknown, then too small; name order within each).
        let shown = free.slice(0, MOVE_TO_LIMIT);
        let sizes: RoomFit[] = [];
        let sizeNote: string | null = null;
        if (attendees != null && free.length) {
          const looked = free.slice(0, FIT_LOOKUP_LIMIT);
          const fits = await lookUpFits(client, looked.map((r) => r.id), attendees);
          const ordered = looked.map((r, i) => ({ r, f: fits[i]! })).sort((a, b) => FIT_ORDER[a.f.fit] - FIT_ORDER[b.f.fit]);
          shown = ordered.slice(0, MOVE_TO_LIMIT).map((o) => o.r);
          sizes = ordered.slice(0, MOVE_TO_LIMIT).map((o) => o.f);
          if (free.length > FIT_LOOKUP_LIMIT) sizeNote = `Room sizes were looked up for the first ${FIT_LOOKUP_LIMIT} of the ${free.length} free rooms by name; the rest were not compared.`;
          if (ordered.every((o) => o.f.fit === "too_small"))
            noneFits = {
              checked: looked.length,
              unread: free.length - looked.length,
              // The largest of the rooms looked up, named from that list (it may not be among the three shown).
              largest: ordered.reduce<{ name: string; capacity: number } | null>((m, o) => (o.f.capacity != null && (!m || o.f.capacity > m.capacity) ? { name: o.r.name, capacity: o.f.capacity } : m), null),
            };
        } else if (shown.length) sizes = await lookUpFits(client, shown.map((r) => r.id), null);
        if (shown.length) roomSizes = { attendees, rooms: sizes, note: sizeNote };
        moveTo = { rooms: shown, more: Math.max(0, free.length - MOVE_TO_LIMIT), note: [partial, shared].filter(Boolean).join(" ") || null };
      }
    } catch (error) {
      moveTo = { rooms: [], more: 0, note: `Could not read the room list, so no free room nearby could be looked for (${msg(error)}).` };
    }
  }
  const freeNames = moveTo?.rooms.length ? `${moveTo.rooms.map((r) => r.name).join(", ")}${moveTo.more ? ` (+${moveTo.more} more)` : ""}` : "";
  // The summary always says what the look found: rooms, none, or that it could not look.
  const lookLine = !moveTo ? "" : freeNames
    ? (room.inMeeting ? "" : ` Free now in the same Zoom location: ${freeNames}.`) + (moveTo.note ? ` ${moveTo.note}` : "")
    : moveTo.note && /^(Could not|Zoom gives no|This room's location)/.test(moveTo.note) ? " Could not look for a free room nearby." : ` No other room in the same Zoom location is free and healthy right now.${moveTo.note ? ` ${moveTo.note}` : ""}`;
  const head = `${room.name}${room.where ? ` (${room.where})` : ""}`;
  // The first suggestion's size, only when there is something to say (a known capacity, or a meeting size to compare).
  const firstSize = roomSizes?.rooms[0];
  // Without a meeting size, the problem room's own seats are named beside the suggestion's: two rooms compared, not a fit.
  const sizeText = firstSize && attendees == null && firstSize.capacity != null && room.seats != null
    ? `seats ${firstSize.capacity}${besideRoom(firstSize.capacity, { name: room.name, seats: room.seats })}; capacity not compared: no meeting size given`
    : firstSize?.text;
  const sizeTag = firstSize && (firstSize.capacity != null || attendees != null) ? ` (${sizeText})` : "";
  const largest = noneFits?.largest;
  const moveHint = !freeNames ? ""
    : noneFits && attendees != null
      ? `; none of the ${noneFits.checked === 1 ? "free room" : `${noneFits.checked} free rooms`} in the same Zoom location whose size was looked up seats ${attendees}${largest ? ` (largest: ${largest.name}, ${largest.capacity} seats)` : ""}${noneFits.unread ? `, and ${noneFits.unread} more free ${noneFits.unread === 1 ? "room was" : "rooms were"} not compared` : ""}`
      : `, or move it to ${moveTo!.rooms[0]!.name}${sizeTag}, free now in the same Zoom location`;
  const meeting = room.inMeeting ? ` A meeting is running in it right now: fix after it ends${moveHint}.` : "";
  let summary: string;
  if (allClear) summary = `${head}: all clear. Health is ${room.health}, the room computer is ${room.status}, and ${devices.length === 1 ? "its 1 device is online" : `all ${devices.length} devices are online`}.${meeting}`;
  else if (findings.length === 0) summary = `${head}: no problems found in what could be read, but not everything could be checked (${couldNotCheck.length}). This is not an all-clear.${meeting}`;
  else {
    const crit = findings.filter((f) => f.level === "critical").length;
    const warn = findings.length - crit;
    const counts = [crit ? `${crit} critical` : "", warn ? `${warn} warning` : ""].filter(Boolean).join(", ");
    const top = findings[0]!;
    summary = `${head}: ${counts}. Start with ${top.subject}: ${top.check}${meeting}${lookLine}${couldNotCheck.length ? ` Not everything could be checked (${couldNotCheck.length}).` : ""}`;
  }
  return { summary, view: "room-diagnosis", room, findings, devices, couldNotCheck, allClear, placeNote, moveTo, roomSizes };
};

/** The diagnosis as plain text: summary, findings worst first, every device, and what could not be checked. */
export const diagnosisText = (d: RoomDiagnosis): string => {
  const lines = [d.summary];
  if (d.findings.length) {
    lines.push("", "Findings, worst first:");
    d.findings.forEach((f, i) => lines.push(`${i + 1}. [${f.level}] ${f.subject}`, `   ${f.detail}`, `   Check: ${f.check}`));
  }
  if (d.moveTo) {
    const m = d.moveTo;
    // "Same Zoom location", not the floor: a location code can be a whole building.
    if (m.rooms.length) lines.push("", `Free now in the same Zoom location, healthy and not in a meeting: ${m.rooms.map((r) => (r.name.endsWith(`(Zoom room ${r.id})`) ? r.name : `${r.name} (${r.id})`)).join(", ")}${m.more ? `, and ${m.more} more` : ""}.${m.note ? ` ${m.note}` : ""}`);
    else lines.push("", m.note && /^(Could not|Zoom gives no|This room's location)/.test(m.note) ? m.note : `No other room in the same Zoom location is healthy and free right now.${m.note ? ` ${m.note}` : ""}`);
    const s = d.roomSizes;
    if (s?.rooms.length) {
      const nameOf = (id: string) => m.rooms.find((r) => r.id === id)?.name ?? id;
      const own = s.attendees == null && d.room?.seats != null ? ` ${d.room.name} seats ${d.room.seats}.` : "";
      lines.push(`Room sizes${s.attendees != null ? ` for a meeting of ${s.attendees}` : ""}: ${s.rooms.map((f) => `${nameOf(f.id)}: ${f.text}`).join("; ")}.${own}${s.note ? ` ${s.note}` : ""}`);
    }
  }
  if (d.devices.length) lines.push("", "Devices:", ...d.devices.map((x) => `- ${x.name} (${x.type}): ${x.status}${x.firmware ? `, firmware ${x.firmware}` : ""}`));
  if (d.couldNotCheck.length) lines.push("", "Could not check:", ...d.couldNotCheck.map((c) => `- ${c}`));
  if (d.placeNote) lines.push("", d.placeNote);
  return lines.join("\n");
};
