// "Which rooms need attention right now?" (2026-11-17). The other tools return raw Zoom data; this one rolls the account
// up: problem rooms worst first, each with its open issues, the devices that are not online, whether a meeting is running
// in it right now, and a plain next step. Read-only: it only calls listRooms, getRoom and getRoomDevices. Anything it
// could not read is listed apart, and it never reports all clear while something could not be read.
import type { ZoomRoomsClient } from "./client.ts";

export type Level = "critical" | "warning";

export interface RoomIssue {
  issue: string;
  severity: string;
  since: string | null;
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
export const nextStep = (room: Pick<AttentionRoom, "status" | "issues" | "devices" | "lastOnline">): string => {
  // An offline room computer comes first: nothing else in the room can be checked until it is back.
  const offline = room.status.toLowerCase() === "offline";
  const specific = deviceStep(room);
  if (offline)
    return `The room computer is offline${room.lastOnline ? ` (last online ${room.lastOnline})` : ""}: check its power and network, then restart Zoom Rooms.${specific ? ` Then: ${specific}` : ""}`;
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

export const roomsNeedingAttention = async (client: ZoomRoomsClient, limit = DETAIL_LIMIT): Promise<Attention> => {
  const couldNotCheck: string[] = [];
  let rooms: any[];
  try {
    rooms = roomsOf(await client.listRooms());
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { summary: `Could not read the room list: ${reason}`, total: 0, needAttention: 0, counts: { critical: 0, warning: 0 }, rooms: [], notReadInDetail: [], couldNotCheck: [`Room list: ${reason}`], allClear: false };
  }

  const unknownHealth = rooms.filter((r) => !levelOf(r) && !/^healthy$/i.test(str(r.health)));
  for (const r of unknownHealth) couldNotCheck.push(`${str(r.name) || str(r.id)}: health is "${str(r.health) || "not reported"}", so it could not be classed as healthy.`);

  const problems = rooms
    .map((r) => ({ r, level: levelOf(r) }))
    .filter((x): x is { r: any; level: Level } => x.level !== null)
    .sort((a, b) => (a.level === b.level ? Number(str(b.r.status).toLowerCase() === "offline") - Number(str(a.r.status).toLowerCase() === "offline") : a.level === "critical" ? -1 : 1));

  const detailed = await Promise.all(
    problems.slice(0, limit).map(async ({ r, level }): Promise<AttentionRoom> => {
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
      const where = loc && typeof loc === "object" ? [str(loc.building), str(loc.floor)].filter(Boolean).join(", ") || null : str(r.location_id) || null;
      const issues: RoomIssue[] = arr(detail?.issues).map((i) => ({ issue: str(i.issue ?? i.description ?? i.name), severity: str(i.severity), since: i.since ? str(i.since) : null }));
      const bad = devices.filter((d) => !OK_DEVICE.test(str(d.status))).map((d) => `${str(d.name) || "Device"} (${str(d.device_type) || "device"}): ${str(d.status) || "no status"}`);
      const base = { status: str(r.status), issues, devices: bad, lastOnline: detail?.last_online ? str(detail.last_online) : null };
      return { id, name, level, health: str(r.health), where, inMeeting: /in ?meeting/i.test(str(r.status)), ...base, next: nextStep(base) };
    }),
  );
  // Within a level: offline first, then the oldest open issue first.
  const firstSince = (room: AttentionRoom) => room.issues.map((i) => i.since ?? "~").sort()[0] ?? "~";
  detailed.sort((a, b) => (a.level === b.level ? Number(b.status.toLowerCase() === "offline") - Number(a.status.toLowerCase() === "offline") || firstSince(a).localeCompare(firstSince(b)) : a.level === "critical" ? -1 : 1));

  const counts = { critical: problems.filter((p) => p.level === "critical").length, warning: problems.filter((p) => p.level === "warning").length };
  const hidden = problems.length - detailed.length;
  const notReadInDetail = problems.slice(limit).map((p) => str(p.r.name) || str(p.r.id));
  const allClear = problems.length === 0 && couldNotCheck.length === 0;
  const lines: string[] = [];
  if (allClear) lines.push(`All ${rooms.length} rooms are healthy and none is offline.`);
  else if (problems.length === 0) lines.push(`No room reports a problem, but not everything could be read, so this is not an all-clear.`);
  else {
    const parts = [counts.critical ? `${counts.critical} critical` : "", counts.warning ? `${counts.warning} warning` : ""].filter(Boolean).join(", ");
    lines.push(`${problems.length} of ${rooms.length} rooms need attention: ${parts}.`);
    detailed.forEach((room, i) => {
      const head = `${i + 1}. [${room.level === "critical" ? "Critical" : "Warning"}] ${room.name}${room.where ? ` (${room.where})` : ""}: ${room.status}${room.inMeeting ? ", in a meeting right now (fix after it ends)" : ""}.`;
      lines.push(head);
      for (const issue of room.issues) lines.push(`   Issue: ${issue.issue}${issue.since ? ` (since ${issue.since})` : ""}.`);
      if (room.devices.length) lines.push(`   Devices not online: ${room.devices.join("; ")}.`);
      lines.push(`   Next: ${room.next}`);
    });
    if (hidden > 0) lines.push(`${hidden} more problem room${hidden === 1 ? "" : "s"} not read in detail: ${notReadInDetail.join(", ")}.`);
    lines.push("For one room's full answer, call diagnose_room with its id.");
  }
  if (couldNotCheck.length) lines.push("", "Could not check:", ...couldNotCheck.map((c) => `- ${c}`));
  return { summary: lines.join("\n"), total: rooms.length, needAttention: problems.length, counts, rooms: detailed, notReadInDetail, couldNotCheck, allClear };
};
