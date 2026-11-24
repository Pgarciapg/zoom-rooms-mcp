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
  assert.match(twins.summary, /2 rooms are called "Board Room" \(Zoom room b, b2\)\. Say which one by its id\./);
  const noLoc = await findFreeRoom(fake([room("q", "Lonely", ""), room("h", "Huddle", "")]), { near: "Lonely" });
  assert.match(noLoc.summary, /Lonely has no Zoom location/);
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
