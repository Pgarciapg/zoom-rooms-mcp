// find_free_room (2026-11-24): "which room is free right now for 8 people, near Board Room?" asked directly, not only
// inside a problem room's diagnosis. It reads and books nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ZoomRoomsClient } from "../src/client.ts";
import { findFreeRoom } from "../src/free-room.ts";
import { createServer, TOOL_NAMES } from "../src/server.ts";

const room = (id: string, name: string, location_id = "L4", status = "Available", health = "Healthy") => ({ id, name, status, health, location_id });
const fake = (rooms: unknown[], seats: Record<string, unknown> = {}, reads: string[] = [], more = false): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms, ...(more ? { next_page_token: "x" } : {}) }),
  getRoom: async (id: string) => {
    reads.push(id);
    const s = seats[id];
    if (s instanceof Error) throw s;
    return s === undefined ? { id } : { id, basic: { name: id, capacity: s } };
  },
  getRoomDevices: async () => ({ devices: [] }),
});
const ROOMS = [
  room("b", "Board Room", "L4", "In Meeting"),
  room("h", "Huddle", "L4"),
  room("m", "Main Conf", "L4"),
  room("s", "Studio", "L4"),
  room("x", "Busy One", "L4", "In Meeting"),
  room("w", "Warning Room", "L4", "Available", "Warning"),
  room("o", "Other Floor", "L9"),
];
const SEATS = { h: 4, m: 14, s: 10, o: 30 };

test("find_free_room is a tool", () => {
  assert.ok((TOOL_NAMES as readonly string[]).includes("find_free_room"));
});

test("with a meeting size: rooms that fit first, smallest first; too small last; busy or unhealthy rooms never listed", async () => {
  const a = await findFreeRoom(fake(ROOMS, SEATS), { attendees: 8, near: "Board Room" });
  assert.deepEqual(a.rooms.map((r) => `${r.name}:${r.fit}`), ["Studio:fits", "Main Conf:fits", "Huddle:too_small"]);
  assert.match(a.summary, /^2 free rooms fit 8 people in the same Zoom location as Board Room; the smallest that fits is Studio \(seats 10\)\./);
  assert.match(a.summary, /check the room's calendar before taking it/);
});

test("near limits to the same Zoom location; without near, every location", async () => {
  const near = await findFreeRoom(fake(ROOMS, SEATS), { near: "board room" });
  assert.ok(!near.rooms.some((r) => r.name === "Other Floor"));
  const all = await findFreeRoom(fake(ROOMS, SEATS));
  assert.ok(all.rooms.some((r) => r.name === "Other Floor"));
  assert.match(all.summary, /^4 rooms are free and healthy right now\./);
});

test("none fits: says so and names the largest; a room with no seats is not compared, never a fit", async () => {
  const a = await findFreeRoom(fake([...ROOMS, room("n", "No Seats", "L4")], SEATS), { attendees: 20, near: "b" });
  assert.match(a.summary, /^None of the free rooms in the same Zoom location as Board Room that were looked up seats 20 people; the largest is Main Conf \(seats 14\)\. 1 room has no seats in Zoom, so it was not compared\./);
  assert.equal(a.rooms.find((r) => r.name === "No Seats")!.fit, "not_compared");
});

test("a room it cannot find, or two with one name, is said plainly; a room with no location is never 'nearby'", async () => {
  const missing = await findFreeRoom(fake(ROOMS), { near: "Nope" });
  assert.match(missing.summary, /No room called "Nope" is in Zoom's room list/);
  assert.deepEqual(missing.rooms, []);
  const twins = await findFreeRoom(fake([...ROOMS, room("b2", "Board Room", "L9")]), { near: "Board Room" });
  assert.match(twins.summary, /2 rooms match "Board Room" by name or Zoom id \("Board Room" \(Zoom room b\), "Board Room" \(Zoom room b2\)\)\. Say which one by its id\./);
  const noLoc = await findFreeRoom(fake([room("q", "Lonely", ""), room("h", "Huddle", "")]), { near: "Lonely" });
  assert.match(noLoc.summary, /has no Zoom location/);
  assert.deepEqual(noLoc.rooms, []);
});

test("past the lookup limit, the rest are counted, not guessed", async () => {
  const many = Array.from({ length: 12 }, (_, i) => room(`f${i}`, `Room ${i + 1}`, "L4"));
  const reads: string[] = [];
  const a = await findFreeRoom(fake(many, {}, reads), { attendees: 4 });
  assert.equal(reads.length, 10);
  assert.equal(a.notLookedUp, 2);
  assert.match(a.summary, /2 more free rooms were not looked up\./);
});

test("a failed seat read or a partial room list is said, never hidden", async () => {
  const a = await findFreeRoom(fake(ROOMS, { ...SEATS, s: new Error("Zoom API 500") }, [], true), { attendees: 8, near: "b" });
  assert.equal(a.rooms.find((r) => r.name === "Studio")!.fit, "not_compared");
  assert.match(a.summary, /Zoom has more pages of rooms than were read/);
  const failed = await findFreeRoom({ ...fake(ROOMS), listRooms: async () => { throw new Error("Zoom API 401"); } });
  assert.match(failed.summary, /^Could not read the room list, so no free room can be named: Zoom API 401\./);
});

test("no free room: says so, and says when the list was partial", async () => {
  const a = await findFreeRoom(fake([room("b", "Board Room", "L4", "In Meeting")], {}, [], true), { near: "b" });
  assert.match(a.summary, /^No room is free and healthy in the same Zoom location as Board Room right now in Zoom's room list\. Not everything could be read/);
});

test("through the server, read-only", async () => {
  const server = createServer({ client: fake(ROOMS, SEATS), source: "demo" } as any);
  const client = new Client({ name: "t", version: "0" });
  const [x, y] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(x), server.connect(y)]);
  const { tools } = await client.listTools();
  assert.equal(tools.find((t) => t.name === "find_free_room")!.annotations?.readOnlyHint, true);
  const r = (await client.callTool({ name: "find_free_room", arguments: { attendees: 8, near: "Board Room" } })) as any;
  assert.match(r.content[0].text, /smallest that fits is Studio/);
});

// From the Sonnet review (2026-11-24).
test("review: past the lookup cap, smallest and largest are said to be of the rooms looked up", async () => {
  const rooms = Array.from({ length: 12 }, (_, i) => room(`r${i + 1}`, `Room ${String(i + 1).padStart(2, "0")}`));
  const seats: Record<string, number> = Object.fromEntries(rooms.map((r) => [r.id, 4]));
  const none = await findFreeRoom(fake(rooms, { ...seats, r11: 20, r12: 8 }), { attendees: 6 });
  assert.match(none.summary, /the largest of the 10 looked up \(the first by name\) is Room 01 \(seats 4\)\. 2 more free rooms were not looked up\./);
  const some = await findFreeRoom(fake(rooms, { ...seats, r1: 10, r12: 6 }), { attendees: 6 });
  assert.match(some.summary, /the smallest that fits of the 10 looked up \(the first by name\) is Room 01/);
  const plain = await findFreeRoom(fake(rooms, seats));
  assert.match(plain.summary, /^12 rooms are free and healthy right now\. Seats were looked up for the first 10 by name\./);
});

test("review: a failed seat read is not blamed on Zoom, and nothing known is not a 'none fits'", async () => {
  const err = new Error("Zoom API 500");
  const a = await findFreeRoom(fake(ROOMS, { h: 4, m: err, s: err }), { attendees: 8, near: "b" });
  assert.match(a.summary, /2 rooms' seats could not be read, so they were not compared\./);
  assert.ok(a.couldNotCheck.includes("Seats for Studio: its Zoom room profile could not be read."), a.couldNotCheck.join(" | "));
  const b = await findFreeRoom(fake(ROOMS, { h: err, m: err, s: err }), { attendees: 3, near: "b" });
  assert.match(b.summary, /^No free room in the same Zoom location as Board Room could be compared with 3 people: none of the 3 rooms looked up has readable seats\./);
});

test("review: a near room not found on a partial list is not called missing", async () => {
  const a = await findFreeRoom(fake(ROOMS, {}, [], true), { near: "Nope" });
  assert.match(a.summary, /No room called "Nope" is in the part of Zoom's room list that could be read/);
});

test("review: a same-named free room carries its id once", async () => {
  const a = await findFreeRoom(fake([room("a", "Lobby"), room("c", "Lobby")], { a: 5 }));
  assert.ok(a.summary.includes("- Lobby (Zoom room a): seats 5"), a.summary);
  assert.ok(!a.summary.includes("(Zoom room a) (Zoom room a)"), a.summary);
});

test("the named room itself, when free, is said first and never listed as nearby", async () => {
  const rooms = [room("b", "Board Room", "L4"), room("h", "Huddle", "L4")];
  const a = await findFreeRoom(fake(rooms, { h: 4 }), { near: "Board Room" });
  assert.match(a.summary, /^Board Room itself is free and healthy right now\. 1 room is free and healthy in the same Zoom location as Board Room right now\./);
  assert.ok(!a.rooms.some((r) => r.name === "Board Room"));
  assert.equal(a.near!.free, true);
  const alone = await findFreeRoom(fake([room("b", "Board Room", "L4")]), { near: "b" });
  assert.match(alone.summary, /^Board Room itself is free and healthy right now\. No other room is free and healthy/);
  const busy = await findFreeRoom(fake(ROOMS, SEATS), { near: "b" });
  assert.doesNotMatch(busy.summary, /itself is free/);
  assert.equal(busy.near!.free, false);
});

// From the Sonnet review (2026-11-24).
test("review: with a meeting size, the named room's own seats are checked, and the rest are 'other' rooms", async () => {
  const rooms = [room("b", "Board Room", "L4"), room("h", "Huddle", "L4")];
  const a = await findFreeRoom(fake(rooms, { b: 14, h: 4 }), { attendees: 12, near: "Board Room" });
  assert.match(a.summary, /^Board Room itself is free and healthy right now \(seats 14, fits 12 people\)\. None of the other free rooms in the same Zoom location as Board Room that were looked up seats 12 people; the largest is Huddle \(seats 4\)\./);
  const small = await findFreeRoom(fake([room("b", "Board Room", "L4")], { b: 6 }), { attendees: 8, near: "b" });
  assert.match(small.summary, /^Board Room itself is free and healthy right now \(seats 6, too small for 8 people\)\. No other room/);
  const noLoc = await findFreeRoom(fake([room("q", "Lonely", "")]), { near: "Lonely" });
  assert.match(noLoc.summary, /^Lonely itself is free and healthy right now, but it has no Zoom location/);
  assert.equal(noLoc.near!.free, true);
});

test("a near that is one room's id and another room's name asks which, never picks silently", async () => {
  const rooms = [room("x", "Alpha", "L4"), room("y", "x", "L9"), room("h", "Huddle", "L4")];
  const a = await findFreeRoom(fake(rooms), { near: "x" });
  assert.match(a.summary, /^2 rooms match "x" by name or Zoom id \("Alpha" \(Zoom room x\), "x" \(Zoom room y\)\)\. Say which one by its id\./);
  assert.deepEqual(a.rooms, []);
  // An id that is also the same room's name is one room.
  const same = await findFreeRoom(fake([room("lobby", "Lobby", "L4"), room("h", "Huddle", "L4")]), { near: "lobby" });
  assert.match(same.summary, /same Zoom location as Lobby/);
});

test("a typed room name with a tab, extra spaces or past 60 characters still matches", async () => {
  const long = "The Very Long Executive Boardroom On The Fourth Floor East Wing Near Lifts";
  const rooms = [room("b", "Board  Room", "L4"), room("l", long, "L5"), room("h", "Huddle", "L4"), room("k", "Kiosk", "L5")];
  assert.match((await findFreeRoom(fake(rooms), { near: "board\troom" })).summary, /same Zoom location as Board +Room/);
  assert.match((await findFreeRoom(fake(rooms), { near: long })).summary, /same Zoom location as The Very Long/);
});
