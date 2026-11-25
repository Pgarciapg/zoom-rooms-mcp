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

// Rooms with no Zoom id (2026-11-24, 12:00 relay). Two same-named rooms with no id were merged into one and one was
// picked silently; nothing could tell them apart, so it must say so rather than pick.
test("two same-named rooms with no Zoom id: never one picked silently; says neither has an id", async () => {
  const noId = (name: string, location_id: string, status = "Available") => ({ name, status, health: "Healthy", location_id });
  const rooms = [noId("Atrium", "L4", "In Meeting"), noId("Atrium", "L9", "In Meeting"), room("h", "Huddle", "L4"), room("o", "Other Floor", "L9")];
  const a = await findFreeRoom(fake(rooms, { h: 4, o: 30 }), { near: "Atrium" });
  assert.deepEqual(a.rooms, []);
  assert.match(a.summary, /^2 rooms are called "Atrium" and none of them has a Zoom id, so I can't tell which one you mean\. Rename one in Zoom, or ask without a room to see free rooms anywhere\./);
  // One named room with no id, and one with an id: the id is how to pick.
  const mixed = await findFreeRoom(fake([noId("Atrium", "L4", "In Meeting"), room("a2", "Atrium", "L9", "In Meeting"), room("o", "Other Floor", "L9")], { o: 30 }), { near: "Atrium" });
  assert.match(mixed.summary, /^2 rooms match "Atrium" by name or Zoom id \("Atrium" \(Zoom room with no id\), "Atrium" \(Zoom room a2\)\)\. Say which one by its id\. The one with no Zoom id can't be picked by id; to ask about it, rename it in Zoom first\./);
  // Picking the one with an id works.
  const picked = await findFreeRoom(fake([noId("Atrium", "L4", "In Meeting"), room("a2", "Atrium", "L9", "In Meeting"), room("o", "Other Floor", "L9")], { o: 30 }), { near: "a2" });
  assert.deepEqual(picked.rooms.map((r) => r.name), ["Other Floor"]);
});

test("a free named room with no Zoom id: its seats are never looked up with an empty id", async () => {
  const reads: string[] = [];
  const a = await findFreeRoom(fake([{ name: "Atrium", status: "Available", health: "Healthy", location_id: "L4" }, room("h", "Huddle", "L4")], { h: 4 }, reads), { near: "Atrium", attendees: 6 });
  assert.ok(!reads.includes(""), `read ids: ${JSON.stringify(reads)}`);
  assert.match(a.summary, /^Atrium itself is free and healthy right now \(its seats can't be looked up: it has no Zoom id\)\. /);
});

// "near" can name a place, not only a room (2026-11-24, 12:00 relay): people think "near the 4th floor of Building 1".
import { DemoZoomRoomsClient } from "../src/client.ts";

test("near a place: a floor by its full name, a whole building, or a floor name two buildings share (asks which)", async () => {
  const demo = new DemoZoomRoomsClient();
  const floor = await findFreeRoom(demo, { near: "building 1, 3rd floor" });
  assert.deepEqual(floor.rooms.map((r) => r.name).sort(), ["Room 301", "Room 303", "Room 304"]);
  assert.match(floor.summary, /in Building 1, 3rd Floor/);
  const building = await findFreeRoom(demo, { near: "Building 2" });
  assert.ok(building.rooms.length > 0);
  assert.ok(building.rooms.every((r) => /Lab|Bldg 2|Training/.test(r.name)), building.rooms.map((r) => r.name).join(", "));
  assert.match(building.summary, /in Main Campus, Building 2/);
  const shared = await findFreeRoom(demo, { near: "1st Floor" });
  assert.deepEqual(shared.rooms, []);
  assert.match(shared.summary, /^"1st Floor" matches more than one place \(Building 1, 1st Floor; Building 2, 1st Floor; Building 3, 1st Floor\)\. Say which one, like "Building 1, 1st Floor"\./);
  assert.ok(!building.rooms.some((r) => /^Room [1-5]0/.test(r.name)), "no Building 1 rooms in Building 2");
});

// From the Sonnet review (2026-11-24, 12:00 relay).
test("review: a campus or building includes every floor under it, by the location tree", async () => {
  const demo = new DemoZoomRoomsClient();
  const campus = await findFreeRoom(demo, { near: "Main Campus" });
  const names = campus.rooms.map((r) => r.name);
  assert.ok(names.some((n) => /^Room 30/.test(n)) && names.some((n) => /^Lab/.test(n)), names.join(", "));
  const building1 = await findFreeRoom(demo, { near: "Building 1" });
  assert.ok(building1.rooms.length > 3);
  assert.equal(building1.place?.locations.every((c) => c.startsWith("bldg-1-")), true);
});

test("review: a location list that could not be read is said, never a silent 'no place'", async () => {
  const rooms = [room("h", "Huddle", "L4")];
  const broken = { ...fake(rooms, { h: 4 }), listLocations: async () => { throw new Error("timeout"); } };
  const a = await findFreeRoom(broken, { near: "Floor 4" });
  assert.ok(a.couldNotCheck.some((c) => /^Places: Zoom's location list could not be read \(timeout\)/.test(c)), a.couldNotCheck.join(" | "));
  assert.match(a.summary, /No room called "Floor 4" is in Zoom's room list/);
});

test("a room name still wins over a place name; no room and no place still says so", async () => {
  const demo = new DemoZoomRoomsClient();
  const room = await findFreeRoom(demo, { near: "Room 302" });
  assert.equal(room.near?.name, "Room 302");
  const nothing = await findFreeRoom(demo, { near: "Moon Base" });
  assert.match(nothing.summary, /No room or place called "Moon Base"/);
});

// BLOCKS SHIP from the 11/24 9:25 PM Codex review: Zoom's documented room list has no `health` field.
test("find_free_room for 8 offers an Available 12-seat room when Zoom's list has no health field", async () => {
  const rows = [{ id: "b", name: "Board Room", status: "In Meeting", location_id: "L4" }, { id: "t", name: "Twelve", status: "Available", location_id: "L4" }];
  const a: any = await findFreeRoom(fake(rows, { t: 12 }), { attendees: 8, near: "Board Room" });
  assert.match(JSON.stringify(a), /Twelve/);
  assert.doesNotMatch(a.summary, /No (other )?room is free/);
});

test("review: the named room with no health is called free, not free and healthy", async () => {
  const rows = [{ id: "b", name: "Board Room", status: "Available", location_id: "L4" }];
  const a: any = await findFreeRoom(fake(rows), { near: "Board Room" });
  assert.match(a.summary, /Board Room itself is free right now \(Zoom gives no health\)/);
  assert.doesNotMatch(a.summary, /Board Room itself is free and healthy/);
});
