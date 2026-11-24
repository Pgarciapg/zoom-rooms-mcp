// "Which room is free right now for 8 people?" (2026-11-24). The move-to suggestion only appeared inside a problem
// room's diagnosis. find_free_room answers it directly: rooms that are Available and Healthy in Zoom's room list, in the
// same Zoom location as a room the person names (or anywhere when none is named), with each room's seats from its Zoom
// profile. With a meeting size, rooms that fit come first, smallest first (so a big room is not used for a small meeting).
// It only reads: nothing is booked. Zoom's room list says whether a room is in a meeting now, not whether it is booked
// later, so the answer says to check the room's calendar before taking it.
import type { ZoomRoomsClient } from "./client.ts";
import { cleanName, FIT_LOOKUP_LIMIT, freeRoomsIn, lookUpFits, type Fit } from "./move-to.ts";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? "" : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface FreeRoom {
  id: string;
  name: string;
  /** Seats from Zoom's room profile; null when Zoom gives none, it could not be read, or it was not looked up. */
  seats: number | null;
  fit: Fit | "not_looked_up";
  text: string;
}

export interface FreeRoomAnswer {
  summary: string;
  view: "free-rooms";
  attendees: number | null;
  /** The room named as "near", when one was found. */
  near: { id: string; name: string; free?: boolean } | null;
  rooms: FreeRoom[];
  /** Free rooms whose seats were not looked up (past the lookup limit). */
  notLookedUp: number;
  couldNotCheck: string[];
}

const CALENDAR = "Free here means healthy and not in a meeting in Zoom's room list right now; Zoom's room list does not show later bookings, so check the room's calendar before taking it.";

export const findFreeRoom = async (client: ZoomRoomsClient, opts: { attendees?: number | null; near?: string | null } = {}): Promise<FreeRoomAnswer> => {
  const attendees = opts.attendees ?? null;
  const base = { view: "free-rooms" as const, attendees, near: null, rooms: [], notLookedUp: 0 };
  const couldNotCheck: string[] = [];
  let rooms: Record<string, unknown>[];
  try {
    const all = (await client.listRooms()) as any;
    const raw: unknown[] = Array.isArray(all) ? all : Array.isArray(all?.rooms) ? all.rooms : [];
    rooms = raw.filter(isObj);
    if (rooms.length < raw.length) couldNotCheck.push(`Room list: ${plural(raw.length - rooms.length, "entry", "entries")} could not be read.`);
    if (str(all?.next_page_token)) couldNotCheck.push("Room list: Zoom has more pages of rooms than were read, so a free room may be missing.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...base, summary: `Could not read the room list, so no free room can be named: ${reason}.`, couldNotCheck: [`Room list: ${reason}`] };
  }

  const idOf = (r: Record<string, unknown>) => str(r.id) || str(r.room_id);
  let near: { id: string; name: string; location: string } | null = null;
  let nearFree = false;
  if (opts.near) {
    // Cleaned the same way stored names are (control characters, length), and runs of spaces count as one.
    const squash = (t: string) => cleanName(t).replace(/\s+/g, " ").toLowerCase();
    const want = squash(opts.near);
    const byId = rooms.filter((r) => squash(idOf(r)) === want);
    const byName = rooms.filter((r) => squash(str(r.name)) === want);
    // One room by its id and another by its name: never pick one silently, ask which (by id).
    const matches = byId.length && byName.some((r) => !byId.some((b) => idOf(b) === idOf(r))) ? [...byId, ...byName] : byId.length ? byId : byName;
    const distinct = [...new Map(matches.map((r) => [idOf(r), r])).values()];
    if (!distinct.length) {
      // Only part of the list was read: the room may be on a page that was not, so absence is not stated as fact.
      const partial = couldNotCheck.length > 0;
      return { ...base, summary: `No room called "${cleanName(opts.near)}" is in ${partial ? "the part of Zoom's room list that could be read" : "Zoom's room list"}, so no nearby free room can be named. Use a name or id from list_zoom_rooms.`, couldNotCheck };
    }
    if (distinct.length > 1)
      return { ...base, summary: `${distinct.length} rooms match "${cleanName(opts.near)}" by name or Zoom id (${distinct.map((r) => `${cleanName(str(r.name)) ? `"${cleanName(str(r.name))}"` : "no name"} (Zoom room ${cleanName(idOf(r)) || "with no id"})`).join(", ")}). Say which one by its id.`, couldNotCheck };
    const r = distinct[0]!;
    near = { id: idOf(r), name: cleanName(str(r.name)) || cleanName(idOf(r)), location: str(r.location_id) };
    // The named room itself is never listed as "nearby", but when it is free and healthy that is the first thing to say.
    nearFree = /^available$/i.test(str(r.status)) && /^healthy$/i.test(str(r.health));
    // A room with no Zoom location has no "same location": say so rather than guess a floor.
    if (!near.location) return { ...base, near: { id: near.id, name: near.name, free: nearFree }, summary: `${nearFree ? `${near.name} itself is free and healthy right now, but it` : near.name} has no Zoom location, so no room can be called nearby. Ask without a room to see free rooms anywhere.`, couldNotCheck };
  }

  const locations = near ? new Set([near.location]) : new Set(rooms.map((r) => str(r.location_id)));
  const free = freeRoomsIn(rooms, new Set(near ? [near.id] : []), locations);
  const where = near ? ` in the same Zoom location as ${near.name}` : "";
  const nearOut = near ? { id: near.id, name: near.name, free: nearFree } : null;
  // With a meeting size, the named room's own seats are looked up too, so "free" never reads as "fits".
  let itself = "";
  if (near && nearFree) {
    const own = attendees != null ? (await lookUpFits(client, [near.id], attendees))[0]! : null;
    itself = `${near.name} itself is free and healthy right now${own ? ` (${own.text})` : ""}. `;
  }
  if (!free.length) {
    const summary = `${itself}No ${itself ? "other " : ""}room is free and healthy${where} right now in Zoom's room list.${couldNotCheck.length ? " Not everything could be read, so this may be incomplete." : ""}`;
    return { ...base, near: nearOut, summary, couldNotCheck };
  }

  const looked = free.slice(0, FIT_LOOKUP_LIMIT);
  const fits = await lookUpFits(client, looked.map((r) => r.id), attendees);
  const out: FreeRoom[] = looked.map((r, i) => ({ id: r.id, name: r.name, seats: fits[i]!.capacity, fit: fits[i]!.fit, text: fits[i]!.text }));
  // A seat read that failed is not "no seats in Zoom": it is said apart, and listed under could not check.
  const failedRead = (r: FreeRoom) => r.seats == null && /could not be read/.test(r.text);
  for (const r of out) if (failedRead(r)) couldNotCheck.push(`Seats for ${r.name}: its Zoom room profile could not be read.`);
  if (attendees != null) {
    // Fits first, smallest first, so a big room stays free for a big meeting; then not compared; then too small.
    const rank: Record<string, number> = { fits: 0, not_compared: 1, too_small: 2 };
    out.sort((a, b) => rank[a.fit]! - rank[b.fit]! || (a.fit === "fits" ? a.seats! - b.seats! : 0));
  }
  const rest = free.slice(FIT_LOOKUP_LIMIT).map((r) => ({ id: r.id, name: r.name, seats: null, fit: "not_looked_up" as const, text: "seats not looked up" }));
  const rooms_ = [...out, ...rest];
  const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

  // Past the lookup limit only the first rooms by name have seats, so "smallest" and "largest" are of those, said so.
  const ofLooked = rest.length ? ` of the ${looked.length} looked up (the first by name)` : "";
  let head: string;
  if (attendees == null) {
    head = `${plural(free.length, "room is", "rooms are")} free and healthy${where} right now.`;
    if (rest.length) head += ` Seats were looked up for the first ${looked.length} by name.`;
  } else {
    const ok = out.filter((r) => r.fit === "fits");
    const noSeats = out.filter((r) => r.fit === "not_compared" && !failedRead(r)).length;
    const failed = out.filter(failedRead).length;
    const sized = out.filter((r) => r.seats != null);
    if (ok.length) head = `${plural(ok.length, "free room fits", "free rooms fit")} ${people(attendees)}${where}; the smallest that fits${ofLooked} is ${ok[0]!.name} (seats ${ok[0]!.seats}).`;
    else if (!sized.length) head = `No free room${where} could be compared with ${people(attendees)}: none of the ${plural(looked.length, "room", "rooms")} looked up has readable seats.`;
    else {
      const largest = sized.reduce<FreeRoom | null>((b, r) => (!b || r.seats! > b.seats! ? r : b), null);
      head = `None of the ${itself ? "other " : ""}free rooms${where} that were looked up seats ${people(attendees)}; the largest${ofLooked} is ${largest!.name} (seats ${largest!.seats}).`;
    }
    if (!ok.length && (noSeats || failed)) {
      const parts = [noSeats && `${plural(noSeats, "room has", "rooms have")} no seats in Zoom`, failed && `${plural(failed, "room's", "rooms'")} seats could not be read`].filter(Boolean).join(" and ");
      if (sized.length) head += ` ${parts}, so ${noSeats + failed === 1 ? "it was" : "they were"} not compared.`;
    }
    if (rest.length) head += ` ${plural(rest.length, "more free room was", "more free rooms were")} not looked up.`;
  }
  head = `${itself}${head}`;
  const lines = [head, "", ...rooms_.map((r) => `- ${r.name}${r.name.includes("(Zoom room ") ? "" : ` (Zoom room ${cleanName(r.id)})`}: ${r.text}`), "", CALENDAR];
  if (couldNotCheck.length) lines.push("", "Could not check:", ...couldNotCheck.map((c) => `- ${c}`));
  return { ...base, near: nearOut, rooms: rooms_, notLookedUp: rest.length, couldNotCheck, summary: lines.join("\n") };
};
