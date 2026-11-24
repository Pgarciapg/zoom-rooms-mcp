// Room size on the move-to suggestion (2026-11-24). A free room's seats come from Zoom's room profile (basic.capacity);
// the meeting size only from the caller. Missing or unreadable on either side is "capacity not compared", never a fit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRoom, diagnosisText } from "../src/diagnose.ts";
import { roomsNeedingAttention } from "../src/attention.ts";
import { fitFor, readCapacity } from "../src/move-to.ts";
import { createServer } from "../src/server.ts";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const broken = { id: "r1", name: "Board Room", status: "In Meeting", health: "Critical", location_id: "L4" };
const free = (id: string, name: string, location_id = "L4") => ({ id, name, status: "Available", health: "Healthy", location_id });
const BROKEN_DETAIL = { id: "r1", name: "Board Room", status: "In Meeting", health: "Critical", location_id: "L4", issues: [{ issue: "Camera disconnected", severity: "critical" }] };

/** Room r1 is broken and in a meeting. `seats` maps a free room id to its profile's basic.capacity; an Error throws. */
const fake = (rooms: unknown[], seats: Record<string, unknown> = {}, reads?: string[]): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id: string) => {
    if (id === "r1") return BROKEN_DETAIL;
    reads?.push(id);
    const s = seats[id];
    if (s instanceof Error) throw s;
    return s === undefined ? { id } : { id, basic: { name: id, capacity: s } };
  },
  getRoomDevices: async () => ({ devices: [{ name: "Rally Camera", device_type: "Camera", status: "Disconnected" }] }),
});
const run = (client: ZoomRoomsClient, attendees?: number) => diagnoseRoom(client, "r1", NOW, undefined, undefined, { moveTo: true, attendees });

test("fits: a room with enough seats says so in the summary and the text", async () => {
  const d = await run(fake([broken, free("r2", "Room 401")], { r2: 12 }), 10);
  assert.deepEqual(d.roomSizes, { attendees: 10, rooms: [{ id: "r2", capacity: 12, fit: "fits", text: "seats 12, fits 10 people" }], note: null });
  assert.match(d.summary, /or move it to Room 401 \(seats 12, fits 10 people\), free now in the same Zoom location\./);
  assert.match(diagnosisText(d), /Room sizes for a meeting of 10: Room 401: seats 12, fits 10 people\./);
});

test("exactly full fits; one seat short does not", async () => {
  assert.equal(fitFor("x", 10, 10).fit, "fits");
  assert.equal(fitFor("x", 9, 10).fit, "too_small");
  assert.equal(fitFor("x", 1, 1).text, "seats 1, fits 1 person");
});

test("does not fit: a too-small room is never the suggested move, and rooms that fit come first", async () => {
  const d = await run(fake([broken, free("r2", "Huddle A"), free("r3", "Room 401")], { r2: 4, r3: 12 }), 10);
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Room 401", "Huddle A"]);
  assert.deepEqual(d.roomSizes?.rooms.map((f) => f.fit), ["fits", "too_small"]);
  assert.match(d.summary, /move it to Room 401 \(seats 12, fits 10 people\)/);
  assert.match(diagnosisText(d), /Huddle A: seats 4, too small for 10 people/);
});

test("does not fit anywhere: no move is suggested, and the largest room is named", async () => {
  const d = await run(fake([broken, free("r2", "Huddle A"), free("r3", "Huddle B")], { r2: 4, r3: 6 }), 10);
  assert.doesNotMatch(d.summary, /move it to/);
  assert.match(d.summary, /fix after it ends; none of the 2 free rooms in the same Zoom location whose size was looked up seats 10 \(largest: Huddle B, 6 seats\)\./);
});

test("capacity unknown: Zoom gives no seats, so it is not compared and the room is still suggested", async () => {
  const d = await run(fake([broken, free("r2", "Room 401")]), 10);
  assert.deepEqual(d.roomSizes?.rooms, [{ id: "r2", capacity: null, fit: "not_compared", text: "capacity not compared: Zoom gives no capacity for it" }]);
  assert.match(d.summary, /move it to Room 401 \(capacity not compared: Zoom gives no capacity for it\)/);
  assert.doesNotMatch(d.summary, /fits|too small/);
});

test("capacity unreadable: a failed profile read is not compared and does not touch the all-clear or could-not-check", async () => {
  const d = await run(fake([broken, free("r2", "Room 401")], { r2: new Error("Zoom API 429") }), 10);
  assert.equal(d.roomSizes?.rooms[0]?.text, "capacity not compared: its capacity could not be read");
  assert.equal(d.couldNotCheck.length, 0);
});

test("capacity unknown ranks after a fit but before too small", async () => {
  const d = await run(fake([broken, free("a", "A small"), free("b", "B unknown"), free("c", "C big")], { a: 2, c: 20 }), 8);
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["C big", "B unknown", "A small"]);
});

test("odd capacities are unknown, never a guess", () => {
  for (const v of [0, -3, 1.5, 501, "abc", "", null, true, { n: 4 }, [8], Number.NaN]) assert.equal(readCapacity({ basic: { capacity: v } }), null, String(v));
  assert.equal(readCapacity({ capacity: 8 }), null); // Only the profile's basic.capacity counts.
  assert.equal(readCapacity({ basic: { capacity: "8" } }), 8);
  assert.equal(readCapacity({ basic: { capacity: 500 } }), 500);
});

test("no meeting size: seats are shown, the fit is not compared, and the order stays by name", async () => {
  const d = await run(fake([broken, free("r2", "Huddle A"), free("r3", "Room 401")], { r2: 4, r3: 12 }));
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Huddle A", "Room 401"]);
  assert.deepEqual(d.roomSizes?.rooms.map((f) => f.fit), ["not_compared", "not_compared"]);
  assert.match(d.summary, /move it to Huddle A \(seats 4; capacity not compared: no meeting size given\)/);
  assert.match(diagnosisText(d), /^Room sizes: Huddle A: seats 4; capacity not compared: no meeting size given; Room 401: seats 12;/m);
});

test("no meeting size and no seats: the summary reads as before", async () => {
  const d = await run(fake([broken, free("r2", "Room 401")]));
  assert.match(d.summary, /or move it to Room 401, free now in the same Zoom location\./);
});

test("with a meeting size, at most ten free rooms are read, and the note says the rest were not compared", async () => {
  const reads: string[] = [];
  const rooms = Array.from({ length: 12 }, (_, i) => free(`f${i}`, `Room ${i + 1}`));
  const d = await run(fake([broken, ...rooms], {}, reads), 5);
  assert.equal(reads.length, 10);
  assert.match(d.roomSizes?.note ?? "", /looked up for the first 10 of the 12 free rooms by name/);
});

test("without a meeting size only the named rooms are read", async () => {
  const reads: string[] = [];
  await run(fake([broken, ...Array.from({ length: 6 }, (_, i) => free(`f${i}`, `Room ${i + 1}`))], {}, reads));
  assert.equal(reads.length, 3);
});

test("attention list: the first suggestion shows its seats, marked not compared", async () => {
  const a = await roomsNeedingAttention(fake([broken, free("r2", "Room 401")], { r2: 12 }), undefined, NOW);
  assert.deepEqual(a.rooms[0]?.moveToSize, { id: "r2", capacity: 12, fit: "not_compared", text: "seats 12; capacity not compared: no meeting size given" });
  assert.match(a.summary, /or move it to Room 401 \(seats 12, capacity not compared\), free now/);
  const unknown = await roomsNeedingAttention(fake([broken, free("r2", "Room 401")]), undefined, NOW);
  assert.match(unknown.summary, /or move it to Room 401, free now/);
});

test("diagnose_room over MCP takes a meeting size and rejects a bad one", async () => {
  const server = createServer({ client: fake([broken, free("r2", "Room 401")], { r2: 6 }), source: "demo", cardHtml: null as any });
  const client = new Client({ name: "capacity-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const ok = (await client.callTool({ name: "diagnose_room", arguments: { roomId: "r1", attendees: 8 } })) as any;
  assert.equal(ok.structuredContent.roomSizes.rooms[0].fit, "too_small");
  for (const bad of [0, 2.5, 5000]) {
    const r = (await client.callTool({ name: "diagnose_room", arguments: { roomId: "r1", attendees: bad } })) as any;
    assert.equal(r.isError, true, String(bad));
  }
});

test("demo campus: the 4th floor suggestion for a 10-person meeting is the room that seats 12", async () => {
  const d = await diagnoseRoom(new DemoZoomRoomsClient(), "rm-001", NOW, undefined, undefined, { moveTo: true, attendees: 10 });
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Room 402", "Room 401"]);
  assert.deepEqual(d.roomSizes?.rooms.map((f) => f.text), ["seats 12, fits 10 people", "seats 6, too small for 10 people"]);
});

// From the Sonnet adversarial review (2026-11-24).
test("review: none fits names the largest room even when it is not among the three shown", async () => {
  const d = await run(fake([broken, free("a", "Room A"), free("b", "Room B"), free("c", "Room C"), free("d", "Room D")], { a: 2, b: 3, c: 4, d: 9 }), 10);
  assert.match(d.summary, /none of the 4 free rooms .* seats 10 \(largest: Room D, 9 seats\)\./);
});

test("review: none fits says when more free rooms were not compared", async () => {
  const rooms = Array.from({ length: 12 }, (_, i) => free(`f${i}`, `Room ${i + 1}`));
  const d = await run(fake([broken, ...rooms], Object.fromEntries(rooms.map((r) => [r.id, 3]))), 10);
  assert.match(d.summary, /none of the 10 free rooms .* seats 10 \(largest: Room 1, 3 seats\), and 2 more free rooms were not compared\./);
});

test("review: with one room of unknown size and the rest too small, the unknown one is suggested, never 'none fits'", async () => {
  const d = await run(fake([broken, free("a", "A small"), free("b", "B unknown")], { a: 2 }), 10);
  assert.match(d.summary, /move it to B unknown \(capacity not compared: Zoom gives no capacity for it\)/);
  assert.doesNotMatch(d.summary, /none of/);
});

test("review: same-named free rooms keep their Zoom ids next to their sizes", async () => {
  const d = await run(fake([broken, free("x1", "Huddle"), free("x2", "Huddle")], { x1: 4, x2: 12 }), 10);
  assert.match(d.summary, /move it to Huddle \(Zoom room x2\) \(seats 12, fits 10 people\)/);
});

test("review: a failed seat read in the attention list is not compared and is not a could-not-check", async () => {
  const a = await roomsNeedingAttention(fake([broken, free("r2", "Room 401")], { r2: new Error("Zoom API 500") }), undefined, NOW);
  assert.equal(a.rooms[0]?.moveToSize?.text, "capacity not compared: its capacity could not be read");
  assert.equal(a.couldNotCheck.length, 0);
  assert.match(a.summary, /or move it to Room 401, free now/);
});
