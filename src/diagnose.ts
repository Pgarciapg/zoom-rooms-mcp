// "Why is this room unhappy, and what do I check first?" (2026-11-20). get_rooms_needing_attention ranks the account;
// this one answers for a single room: every problem it can see (the room computer, each open issue, each device that is
// not online), with the open issue and the failing device joined into one finding when they describe the same thing,
// worst first, each with one check. Read-only: it only calls getRoom and getRoomDevices, plus listRooms when the room
// detail does not carry its status or health. Anything it could not read is listed apart, and it never reports all
// clear while something could not be read.
import { deviceStep, type RoomIssue } from "./attention.ts";
import type { ZoomRoomsClient } from "./client.ts";

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
  status: string;
  health: string;
  inMeeting: boolean;
  lastOnline: string | null;
}

export interface RoomDiagnosis {
  summary: string;
  view: "room-diagnosis";
  room: RoomFacts | null;
  findings: RoomFinding[];
  devices: DeviceRow[];
  couldNotCheck: string[];
  allClear: boolean;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const OK_DEVICE = /^(online|connected|available|in ?use)$/i;
const KNOWN_HEALTH = /^(healthy|warning|critical)$/i;

/** Device kinds an issue text can name, keyed by the words that name them. */
const KINDS: [RegExp, RegExp][] = [
  [/camera/i, /camera/i],
  [/\b(mic|microphone)s?\b/i, /mic/i],
  [/speaker|audio/i, /speaker|audio/i],
  [/display|screen|hdmi|tv\b/i, /display|screen|tv/i],
  [/controller|touch ?panel/i, /controller|touch/i],
];

/** True when the issue text and the device describe the same thing: same device name, or same kind of device. */
const sameThing = (issue: string, device: DeviceRow): boolean => {
  const text = issue.toLowerCase();
  if (device.name && text.includes(device.name.toLowerCase())) return true;
  return KINDS.some(([inIssue, inType]) => inIssue.test(text) && inType.test(`${device.type} ${device.name}`));
};

const levelOfSeverity = (severity: string): FindingLevel => (/crit|high|severe|error/i.test(severity) ? "critical" : "warning");

/** "about 3 h" / "about 4 days", or null when the time is missing, unreadable or in the future. */
export const ago = (iso: string | null, now: number): string | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at > now) return null;
  const hours = (now - at) / 3_600_000;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `about ${Math.round(hours)} h`;
  return `about ${Math.round(hours / 24).toLocaleString("en-US")} days`;
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const GENERIC_DEVICE_CHECK = "Check the device's power and cable, then look at it in the Zoom admin portal.";
const GENERIC_ISSUE_CHECK = "Open the room in the Zoom admin portal and read its full alert.";

export const diagnoseRoom = async (client: ZoomRoomsClient, roomId: string, now = Date.now()): Promise<RoomDiagnosis> => {
  const couldNotCheck: string[] = [];
  let detail: any = null;
  let deviceData: any[] | null = null;
  try {
    detail = await client.getRoom(roomId);
  } catch (error) {
    couldNotCheck.push(`Room details: ${msg(error)}`);
  }
  try {
    deviceData = arr(((await client.getRoomDevices(roomId)) as any)?.devices);
  } catch (error) {
    couldNotCheck.push(`Devices: ${msg(error)}`);
  }

  // The room's status and health come from its detail; when the detail lacks them, read them from the room list.
  let listed: any = null;
  if (!str(detail?.status) || !str(detail?.health)) {
    try {
      const all = (await client.listRooms()) as any;
      const rooms = Array.isArray(all) ? all : arr(all?.rooms);
      listed = rooms.find((r) => str(r.id) === roomId || str(r.room_id) === roomId) ?? null;
      if (!listed && detail) couldNotCheck.push(`Status and health: room ${roomId} is not in the room list.`);
    } catch (error) {
      couldNotCheck.push(`Status and health (room list): ${msg(error)}`);
    }
  }

  if (!detail && !listed) {
    const summary = `Could not check room ${roomId}: ${couldNotCheck[0]?.replace(/^[^:]+: /, "") ?? "it did not answer"}. This is not an all-clear.`;
    return { summary, view: "room-diagnosis", room: null, findings: [], devices: [], couldNotCheck, allClear: false };
  }

  const loc = detail?.location;
  const room: RoomFacts = {
    id: str(detail?.id) || str(listed?.id) || roomId,
    name: str(detail?.name) || str(listed?.name) || roomId,
    where: loc && typeof loc === "object" ? [str(loc.building), str(loc.floor)].filter(Boolean).join(", ") || null : str(listed?.location_id ?? detail?.location_id) || null,
    status: str(detail?.status) || str(listed?.status),
    health: str(detail?.health) || str(listed?.health),
    inMeeting: false,
    lastOnline: detail?.last_online ? str(detail.last_online) : null,
  };
  room.inMeeting = /in ?meeting/i.test(room.status);
  if (!KNOWN_HEALTH.test(room.health)) couldNotCheck.push(`Health: "${room.health || "not reported"}", so the room could not be classed as healthy.`);

  const devices: DeviceRow[] = (deviceData ?? []).map((d) => {
    const status = str(d.status) || "no status";
    return { name: str(d.name) || "Device", type: str(d.device_type) || "device", status, firmware: d.firmware ? str(d.firmware) : null, ok: OK_DEVICE.test(status) };
  });
  // An empty device list usually means Zoom could not see the devices, not that the room has none.
  if (deviceData && devices.length === 0) couldNotCheck.push("Devices: Zoom listed no devices for this room, so none could be checked.");
  const issues: RoomIssue[] = arr(detail?.issues).map((i) => ({ issue: str(i.issue ?? i.description ?? i.name), severity: str(i.severity), since: i.since ? str(i.since) : null }));

  const findings: RoomFinding[] = [];
  const offline = room.status.toLowerCase() === "offline";
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
  for (const device of devices.filter((d) => !d.ok)) {
    const matchIdx = issues.findIndex((issue, i) => !usedIssues.has(i) && sameThing(issue.issue, device));
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
  const head = `${room.name}${room.where ? ` (${room.where})` : ""}`;
  const meeting = room.inMeeting ? " A meeting is running in it right now: fix after it ends." : "";
  let summary: string;
  if (allClear) summary = `${head}: all clear. Health is ${room.health}, the room computer is ${room.status || "up"}, and all ${plural(devices.length, "device")} are online.${meeting}`;
  else if (findings.length === 0) summary = `${head}: no problems found in what could be read, but not everything could be checked (${couldNotCheck.length}). This is not an all-clear.${meeting}`;
  else {
    const crit = findings.filter((f) => f.level === "critical").length;
    const warn = findings.length - crit;
    const counts = [crit ? `${crit} critical` : "", warn ? `${warn} warning` : ""].filter(Boolean).join(", ");
    const top = findings[0]!;
    summary = `${head}: ${counts}. Start with ${top.subject}: ${top.check}${meeting}${couldNotCheck.length ? ` Not everything could be checked (${couldNotCheck.length}).` : ""}`;
  }
  return { summary, view: "room-diagnosis", room, findings, devices, couldNotCheck, allClear };
};

/** The diagnosis as plain text: summary, findings worst first, every device, and what could not be checked. */
export const diagnosisText = (d: RoomDiagnosis): string => {
  const lines = [d.summary];
  if (d.findings.length) {
    lines.push("", "Findings, worst first:");
    d.findings.forEach((f, i) => lines.push(`${i + 1}. [${f.level}] ${f.subject}`, `   ${f.detail}`, `   Check: ${f.check}`));
  }
  if (d.devices.length) lines.push("", "Devices:", ...d.devices.map((x) => `- ${x.name} (${x.type}): ${x.status}${x.firmware ? `, firmware ${x.firmware}` : ""}`));
  if (d.couldNotCheck.length) lines.push("", "Could not check:", ...d.couldNotCheck.map((c) => `- ${c}`));
  return lines.join("\n");
};
