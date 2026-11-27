// Where the meeting can go (2026-11-23). diagnose_room said what was broken and that a meeting was running, but never
// where people could move. Now a problem room names up to three other rooms in the same Zoom location that are healthy
// and free right now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRoom, diagnosisText } from "../src/diagnose.ts";
import { createServer } from "../src/server.ts";

const NOW = Date.parse("2026-11-23T17:00:00Z");
const broken = { id: "r1", name: "Board Room", status: "In Meeting", health: "Critical", location_id: "L4" };
const row = (id: string, name: string, status: string, health: string, location_id = "L4") => ({ id, name, status, health, location_id });

/** A fake client: room r1 has a disconnected camera; `rooms` is the room list (an Error makes it throw). */
const fake = (rooms: unknown[] | Error, opts: { detailLoc?: string | null; nextPage?: string; listCalls?: { n: number } } = {}): ZoomRoomsClient => ({
  listRooms: async () => {
    if (opts.listCalls) opts.listCalls.n++;
    if (rooms instanceof Error) throw rooms;
    return { rooms, ...(opts.nextPage ? { next_page_token: opts.nextPage } : {}) };
  },
  getRoom: async () => ({
    id: "r1", name: "Board Room", status: "In Meeting", health: "Critical",
    ...(opts.detailLoc === null ? {} : { location_id: opts.detailLoc ?? "L4" }),
    issues: [{ issue: "Camera disconnected", severity: "critical", since: "2026-11-23T16:00:00Z" }],
  }),
  getRoomDevices: async () => ({ devices: [{ name: "Rally Camera", device_type: "Camera", status: "Disconnected" }] }),
});
const run = (client: ZoomRoomsClient) => diagnoseRoom(client, "r1", NOW, undefined, undefined, { moveTo: true });

// Changed 11/25: Zoom's documented room list has no health field, so a free room with none ("Room 406") is offered last,
// marked, instead of dropped (the 11/24 Codex review rated dropping it HIGH).
test("names free, healthy rooms in the same place, then free rooms with no health given, and never busy, offline, unhealthy or other-floor rooms", async () => {
  const d = await run(fake([
    broken,
    row("r2", "Room 402", "Available", "Healthy"),
    row("r3", "Room 401", "Available", "Healthy"),
    row("r4", "Room 403", "In Meeting", "Healthy"),
    row("r5", "Room 404", "Offline", "Healthy"),
    row("r6", "Room 405", "Available", "Warning"),
    row("r7", "Room 406", "Available", ""),
    row("r8", "Room 501", "Available", "Healthy", "L5"),
  ]));
  assert.deepEqual(d.moveTo, { rooms: [{ id: "r3", name: "Room 401" }, { id: "r2", name: "Room 402" }, { id: "r7", name: "Room 406 (Zoom gives no health)" }], more: 0, note: null });
  assert.match(d.summary, /A meeting is running in it right now: fix after it ends, or move it to Room 401, free now in the same Zoom location\./);
  assert.match(diagnosisText(d), /Free now in the same Zoom location, healthy and not in a meeting: Room 401 \(r3\), Room 402 \(r2\), Room 406 \(Zoom gives no health\) \(r7\)\./);
});

test("at most three are named; the rest are counted", async () => {
  const d = await run(fake([broken, ...["A", "B", "C", "D", "E"].map((n, i) => row(`f${i}`, `Room ${n}`, "Available", "Healthy"))]));
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Room A", "Room B", "Room C"]);
  assert.equal(d.moveTo?.more, 2);
  assert.match(diagnosisText(d), /Room C \(f2\), and 2 more\./);
});

test("none free says so plainly", async () => {
  const d = await run(fake([broken, row("r2", "Room 402", "In Meeting", "Healthy")]));
  assert.deepEqual(d.moveTo, { rooms: [], more: 0, note: null });
  assert.match(diagnosisText(d), /No other room in the same Zoom location is healthy and free right now\./);
  assert.doesNotMatch(d.summary, /move it to/);
});

test("a room list that cannot be read says it could not look, never 'none free', and is not a could-not-check", async () => {
  const d = await run(fake(new Error("Zoom API 429 on /rooms: slow down")));
  assert.equal(d.moveTo?.rooms.length, 0);
  assert.match(d.moveTo!.note!, /^Could not read the room list, so no free room nearby could be looked for/);
  assert.doesNotMatch(diagnosisText(d), /No other room in the same place/);
  assert.equal(d.couldNotCheck.length, 0);
});

test("the location code comes from the room's list row when the detail has none", async () => {
  const d = await run(fake([broken, row("r2", "Room 402", "Available", "Healthy")], { detailLoc: null }));
  assert.deepEqual(d.moveTo?.rooms, [{ id: "r2", name: "Room 402" }]);
});

test("no location anywhere: no suggestion, and it says why", async () => {
  const d = await run(fake([{ ...broken, location_id: "" }, row("r2", "Room 402", "Available", "Healthy", "")], { detailLoc: null }));
  assert.deepEqual(d.moveTo, { rooms: [], more: 0, note: "Zoom gives no location for this room, so no room nearby could be suggested." });
});

test("a partial room list says there may be more", async () => {
  const d = await run(fake([broken, row("r2", "Room 402", "Available", "Healthy")], { nextPage: "tok" }));
  assert.match(d.moveTo!.note!, /Only part of Zoom's room list was read/);
});

test("a healthy room is not looked for, and the room list is not read for it", async () => {
  const calls = { n: 0 };
  const client: ZoomRoomsClient = {
    ...fake([], { listCalls: calls }),
    getRoom: async () => ({ id: "r9", name: "Huddle", status: "Available", health: "Healthy", location_id: "L4", issues: [] }),
    getRoomDevices: async () => ({ devices: [{ name: "Cam", device_type: "Camera", status: "Online" }] }),
  };
  const d = await diagnoseRoom(client, "r9", NOW, undefined, undefined, { moveTo: true });
  assert.equal(d.allClear, true);
  assert.equal(d.moveTo, null);
  assert.equal(calls.n, 0);
});

test("diagnose_room over MCP names the free rooms on the demo's 4th floor", async () => {
  const server = createServer({ client: new DemoZoomRoomsClient(), source: "demo", cardHtml: null as any });
  const client = new Client({ name: "move-to-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const r = (await client.callTool({ name: "diagnose_room", arguments: { roomId: "rm-001" } })) as any;
  assert.deepEqual(r.structuredContent.moveTo.rooms.map((x: any) => x.name), ["Room 401", "Room 402"]);
  assert.match(r.content[0].text, /Free now in the same Zoom location: Room 401, Room 402\./);
});

// From the Sonnet adversarial review (2026-11-23).
test("the summary always says what the look found: none free, could not look, or may be more", async () => {
  const none = await run(fake([broken, row("r2", "Room 402", "In Meeting", "Healthy")]));
  assert.match(none.summary, /No other room in the same Zoom location is free and healthy right now\./);
  const failed = await run(fake(new Error("Zoom API 429")));
  assert.match(failed.summary, /Could not look for a free room nearby\./);
  const partial = await run(fake([broken, row("r2", "Room 402", "Available", "Healthy")], { nextPage: "tok" }));
  assert.match(partial.summary, /Only part of Zoom's room list was read, so there may be more\./);
});

test("the text never claims the same floor: a location code can be a whole building", async () => {
  const d = await run(fake([broken, row("r2", "Room on 9", "Available", "Healthy")]));
  assert.doesNotMatch(diagnosisText(d), /same place/);
  assert.match(diagnosisText(d), /Free now in the same Zoom location, healthy and not in a meeting: Room on 9 \(r2\)\./);
});

test("a partial list without the room's own row says so, not 'no location'", async () => {
  const d = await run(fake([row("r2", "Room 402", "Available", "Healthy")], { detailLoc: null, nextPage: "tok" }));
  assert.equal(d.moveTo?.note, "This room's location was not in the part of Zoom's room list that was read, so no room nearby could be suggested.");
});

test("duplicate rows, rows with no id, and odd names are handled", async () => {
  const d = await run(fake([broken, row("r2", "Room A", "Available", "Healthy"), row("r2", "Room A", "Available", "Healthy"), row("", "", "Available", "Healthy"), row("r3", "Room\nB (+9 more)", "Available", "Healthy")]));
  assert.deepEqual(d.moveTo?.rooms, [{ id: "r2", name: "Room A" }, { id: "r3", name: "Room B (+9 more)" }]);
  assert.doesNotMatch(d.summary, /\n/);
});

test("a detail and list row that disagree on the code both count", async () => {
  const d = await run(fake([{ ...broken, location_id: "L9" }, row("r2", "Room 902", "Available", "Healthy", "L9")]));
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Room 902"]);
});

test("a room list that already failed is not read again", async () => {
  const calls = { n: 0 };
  const client: ZoomRoomsClient = { ...fake(new Error("Zoom API 503"), { listCalls: calls }), getRoom: async () => ({ id: "r1", name: "Board Room", location_id: "L4", issues: [{ issue: "Camera disconnected", severity: "critical" }] }) };
  const d = await diagnoseRoom(client, "r1", NOW, undefined, undefined, { moveTo: true });
  assert.equal(calls.n, 1);
  assert.match(d.moveTo!.note!, /^Could not read the room list/);
});

// get_rooms_needing_attention ("start here") uses the same rule for a problem room in a meeting (2026-11-23).
import { roomsNeedingAttention } from "../src/attention.ts";

test("the attention list offers a free room for a problem room in a meeting, with no extra Zoom call", async () => {
  const calls = { n: 0 };
  const client = fake([
    broken,
    row("r2", "Room 402", "Available", "Healthy"),
    row("r3", "Room 401", "Available", "Healthy"),
    row("r4", "Room 403", "In Meeting", "Healthy"),
    row("r5", "Room 501", "Available", "Healthy", "L5"),
  ], { listCalls: calls });
  const a = await roomsNeedingAttention(client);
  assert.equal(calls.n, 1);
  assert.deepEqual(a.rooms[0]!.moveTo, [{ id: "r3", name: "Room 401" }, { id: "r2", name: "Room 402" }]);
  assert.match(a.summary, /in a meeting right now \(fix after it ends, or move it to Room 401, free now in the same Zoom location\)\./);
});

test("the attention list says nothing extra when no room is free, or the problem room is not in a meeting", async () => {
  const busy = await roomsNeedingAttention(fake([broken, row("r4", "Room 403", "In Meeting", "Healthy")]));
  assert.deepEqual(busy.rooms[0]!.moveTo, []);
  assert.match(busy.summary, /in a meeting right now \(fix after it ends\)\./);
  const idle = await roomsNeedingAttention(fake([{ ...broken, status: "Available" }, row("r2", "Room 402", "Available", "Healthy")]));
  assert.deepEqual(idle.rooms[0]!.moveTo, []);
  assert.doesNotMatch(idle.summary, /move it to/);
});

// From the short Sonnet review of the attention change (2026-11-23).
test('"Not in meeting" is not a meeting, and names sort with numbers in order', async () => {
  const notIn = await roomsNeedingAttention(fake([{ ...broken, status: "Not in meeting" }, row("r2", "Room 402", "Available", "Healthy")]));
  assert.equal(notIn.rooms[0]!.inMeeting, false);
  assert.doesNotMatch(notIn.summary, /in a meeting right now|move it to/);
  const sorted = await roomsNeedingAttention(fake([broken, row("r2", "Room 10", "Available", "Healthy"), row("r3", "Room 2", "Available", "Healthy")]));
  assert.deepEqual(sorted.rooms[0]!.moveTo.map((r) => r.name), ["Room 2", "Room 10"]);
});

test("a free room whose name is only control characters is shown by its id", async () => {
  const a = await roomsNeedingAttention(fake([broken, row("r2", "\u0001", "Available", "Healthy")]));
  assert.deepEqual(a.rooms[0]!.moveTo, [{ id: "r2", name: "r2" }]);
  assert.match(a.summary, /or move it to r2, free now/);
});

// Two meetings displaced at once (2026-11-23, 1:30 relay). Each in-meeting problem room was pointed at the same first
// free room, which only moved the collision. Now each gets a different free room, worst room first, and a room left
// without one says the free rooms nearby are already suggested for the rooms above it.
/** A fake whose room details come from the list row, so several problem rooms can be read. */
const many = (rooms: Record<string, unknown>[]): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id: string) => {
    const r = rooms.find((x) => x.id === id)!;
    return { ...r, issues: [{ issue: "Camera disconnected", severity: "critical", since: String(r.since ?? "2026-11-23T16:00:00Z") }] };
  },
  getRoomDevices: async () => ({ devices: [] }),
});

test("two meetings in the same place are sent to different free rooms", async () => {
  const a = await roomsNeedingAttention(many([
    { ...row("m1", "Board Room", "In Meeting", "Critical"), since: "2026-11-23T15:00:00Z" },
    { ...row("m2", "Huddle 4", "In Meeting", "Critical"), since: "2026-11-23T16:00:00Z" },
    row("f1", "Room 401", "Available", "Healthy"),
    row("f2", "Room 402", "Available", "Healthy"),
  ]));
  assert.deepEqual(a.rooms.map((r) => r.name), ["Board Room", "Huddle 4"]);
  assert.equal(a.rooms[0]!.moveTo[0]!.name, "Room 401");
  assert.equal(a.rooms[1]!.moveTo[0]!.name, "Room 402");
  // A room's list never offers a room already given to another meeting.
  assert.deepEqual(a.rooms[0]!.moveTo.map((r) => r.name), ["Room 401"]);
  assert.deepEqual(a.rooms[1]!.moveTo.map((r) => r.name), ["Room 402"]);
  assert.match(a.summary, /Board Room \(L4\)?.*or move it to Room 401,/);
  assert.match(a.summary, /Huddle 4.*or move it to Room 402,/);
});

test("with one free room, the second meeting is told it is already suggested, not pointed at it silently", async () => {
  const a = await roomsNeedingAttention(many([
    { ...row("m1", "Board Room", "In Meeting", "Critical"), since: "2026-11-23T15:00:00Z" },
    { ...row("m2", "Huddle 4", "In Meeting", "Critical"), since: "2026-11-23T16:00:00Z" },
    row("f1", "Room 401", "Available", "Healthy"),
  ]));
  assert.equal(a.rooms[0]!.moveTo[0]!.name, "Room 401");
  assert.deepEqual(a.rooms[1]!.moveTo, []);
  assert.equal(a.rooms[1]!.moveToNote, "the only free room in the same Zoom location, Room 401, is suggested for Board Room");
  assert.match(a.summary, /Huddle 4[^\n]*in a meeting right now \(fix after it ends; the only free room in the same Zoom location, Room 401, is suggested for Board Room\)\./);
  assert.equal(a.rooms[0]!.moveToNote, null);
});

test("the worst room gets first pick, and rooms in other places do not compete", async () => {
  const a = await roomsNeedingAttention(many([
    { ...row("w1", "Huddle 4", "In Meeting", "Warning") },
    { ...row("c1", "Board Room", "In Meeting", "Critical") },
    { ...row("x1", "Room 500", "In Meeting", "Critical", "L5") },
    row("f1", "Room 401", "Available", "Healthy"),
    row("f5", "Room 501", "Available", "Healthy", "L5"),
  ]));
  const by = Object.fromEntries(a.rooms.map((r) => [r.name, r]));
  assert.equal(by["Board Room"]!.moveTo[0]!.name, "Room 401");
  assert.equal(by["Room 500"]!.moveTo[0]!.name, "Room 501");
  assert.deepEqual(by["Huddle 4"]!.moveTo, []);
  assert.match(by["Huddle 4"]!.moveToNote!, /Room 401, is suggested for Board Room$/);
});

test("several free rooms all taken are listed by name, and a room not in a meeting takes none", async () => {
  const a = await roomsNeedingAttention(many([
    { ...row("m1", "A Room", "In Meeting", "Critical"), since: "2026-11-23T14:00:00Z" },
    { ...row("m2", "B Room", "In Meeting", "Critical"), since: "2026-11-23T15:00:00Z" },
    { ...row("m3", "C Room", "In Meeting", "Critical"), since: "2026-11-23T16:00:00Z" },
    { ...row("i1", "Idle Room", "Available", "Critical"), since: "2026-11-23T13:00:00Z" },
    row("f1", "Room 401", "Available", "Healthy"),
    row("f2", "Room 402", "Available", "Healthy"),
  ]));
  const by = Object.fromEntries(a.rooms.map((r) => [r.name, r]));
  assert.deepEqual(by["Idle Room"]!.moveTo, []);
  assert.equal(by["Idle Room"]!.moveToNote, null);
  assert.equal(by["A Room"]!.moveTo[0]!.name, "Room 401");
  assert.equal(by["B Room"]!.moveTo[0]!.name, "Room 402");
  assert.equal(by["C Room"]!.moveToNote, "the 2 free rooms in the same Zoom location (Room 401, Room 402) are suggested for A Room and B Room");
});

// From the Sonnet review of the allocation (2026-11-23).
import { allocateMoveTo, freeRoomsIn } from "../src/move-to.ts";

test("a room with two options leaves the only option of a later room alone", () => {
  const r1 = { id: "R1", name: "Room 1" }, r2 = { id: "R2", name: "Room 2" };
  const out = allocateMoveTo([{ name: "A", candidates: [r1, r2] }, { name: "B", candidates: [r1] }]);
  assert.equal(out[0]!.moveTo[0]!.id, "R2");
  assert.equal(out[1]!.moveTo[0]!.id, "R1");
  assert.equal(out[1]!.moveToNote, null);
});

test("a taker's name in the note is cleaned to one short line", () => {
  const r1 = { id: "R1", name: "Room 1" };
  const out = allocateMoveTo([{ name: "Board\nRoom", candidates: [r1] }, { name: "B", candidates: [r1] }]);
  assert.equal(out[1]!.moveToNote, "the only free room in the same Zoom location, Room 1, is suggested for Board Room");
});

test("diagnose_room says when another problem room nearby is also in a meeting, so it does not contradict the list", async () => {
  const d = await run(fake([
    broken,
    row("h4", "Huddle 4", "In Meeting", "Warning"),
    row("ok", "Room 403", "In Meeting", "Healthy"),
    row("f1", "Room 401", "Available", "Healthy"),
  ]));
  assert.match(d.summary, /Another problem room here, Huddle 4, is also in a meeting; get_rooms_needing_attention gives each meeting a different free room\./);
  assert.doesNotMatch(d.summary, /Room 403, is also/);
  const alone = await run(fake([broken, row("ok", "Room 403", "In Meeting", "Healthy"), row("f1", "Room 401", "Available", "Healthy")]));
  assert.doesNotMatch(alone.summary, /also in a meeting/);
});

// Kept item from the move-apart review (2026-11-23, 3:00 relay): backups after the first could repeat across meetings,
// so two meetings could both fall back to the same spare room.
test("backup rooms are never shared between two meetings", () => {
  const r = (n: number) => ({ id: `R${n}`, name: `Room ${n}` });
  const all = [r(1), r(2), r(3), r(4), r(5)];
  const out = allocateMoveTo([{ name: "A", candidates: all }, { name: "B", candidates: all }]);
  const ids = out.flatMap((o) => o.moveTo.map((m) => m.id));
  assert.equal(new Set(ids).size, ids.length, ids.join(" "));
  assert.equal(out[0]!.moveTo.length, 3);
  assert.equal(out[1]!.moveTo.length, 2); // its own pick plus the one spare left
  // Fewer spares than meetings: the later meeting keeps its own pick and simply has no backup.
  const tight = allocateMoveTo([{ name: "A", candidates: all.slice(0, 3) }, { name: "B", candidates: all.slice(0, 3) }]);
  assert.deepEqual(tight.map((o) => o.moveTo.length), [2, 1]);
  assert.equal(tight[1]!.moveToNote, null);
});

test("review: one meeting's list never repeats a room", () => {
  const r = (n: number) => ({ id: `R${n}`, name: `Room ${n}` });
  const one = allocateMoveTo([{ name: "A", candidates: [r(1), r(2), r(2), r(3)] }]);
  assert.deepEqual(one[0]!.moveTo.map((m) => m.id), ["R1", "R2", "R3"]);
});

// Kept Low from the move-apart review (2026-11-23, 3:00 relay): same-named rooms read ambiguously.
test("two problem rooms with the same name are told apart by their number in the list", () => {
  const r1 = { id: "R1", name: "Room 1" };
  const out = allocateMoveTo([{ name: "Lobby", candidates: [r1] }, { name: "lobby", candidates: [r1] }, { name: "Board", candidates: [r1] }]);
  assert.equal(out[1]!.moveToNote, "the only free room in the same Zoom location, Room 1, is suggested for Lobby (number 1 in this list)");
  const plain = allocateMoveTo([{ name: "Lobby", candidates: [r1] }, { name: "Board", candidates: [r1] }]);
  assert.equal(plain[1]!.moveToNote, "the only free room in the same Zoom location, Room 1, is suggested for Lobby");
});

test("two free rooms with the same name carry Zoom's room id", () => {
  const row = (id: string, name: string) => ({ id, name, location_id: "L1", status: "Available", health: "Healthy" });
  const free = freeRoomsIn([row("aaa", "Huddle"), row("bbb", "huddle"), row("ccc", "Room 5")], new Set(["x"]), new Set(["L1"]));
  assert.deepEqual(free.map((f) => f.name).sort(), ["Huddle (Zoom room aaa)", "huddle (Zoom room bbb)", "Room 5"].sort());
});

test("review: diagnose_room does not print a same-named free room's id twice", async () => {
  const d = await run(fake([broken, row("aaa", "Huddle", "Available", "Healthy"), row("bbb", "Huddle", "Available", "Healthy")]));
  const text = (await import("../src/diagnose.ts")).diagnosisText(d);
  assert.match(text, /Huddle \(Zoom room aaa\)/);
  assert.doesNotMatch(text, /\(Zoom room aaa\) \(aaa\)/);
});

// BLOCKS SHIP from the 11/24 9:25 PM Codex review: Zoom's documented room list has no `health` field, so requiring
// "Healthy" there rejected every room on a live account. A free room with no health reported is still offered, marked.
test("a free room with no health field in Zoom's list is still offered, marked as health not reported", () => {
  const free = freeRoomsIn([{ id: "big", name: "Room 12", location_id: "L1", status: "Available" }, { id: "w", name: "Warn", location_id: "L1", status: "Available", health: "Warning" }], new Set(), new Set(["L1"]));
  assert.deepEqual(free, [{ id: "big", name: "Room 12 (Zoom gives no health)" }]);
});

test("review: two same-named free rooms with no health keep the id suffix last", () => {
  const row = (id: string) => ({ id, name: "Huddle", location_id: "L1", status: "Available" });
  const free = freeRoomsIn([row("r1"), row("r2")], new Set(), new Set(["L1"]));
  assert.deepEqual(free.map((f) => f.name), ["Huddle (Zoom gives no health) (Zoom room r1)", "Huddle (Zoom gives no health) (Zoom room r2)"]);
});

// Codex review of b4974a8 (MEDIUM, 11/25): the greedy allocator could leave a meeting without a room.
for (const [label, rows] of [
  ["A W/X, B W, C X/Z", [["A", "W", "X"], ["B", "W"], ["C", "X", "Z"]]],
  ["A Y/Z, B X/Z, C X, D W/Z", [["A", "Y", "Z"], ["B", "X", "Z"], ["C", "X"], ["D", "W", "Z"]]],
  ["A X/Y, B X/Z, C X/Z, D Y/W", [["A", "X", "Y"], ["B", "X", "Z"], ["C", "X", "Z"], ["D", "Y", "W"]]],
] as const) {
  test(`review: meetings ${label} all get a room of their own`, () => {
    const got = allocateMoveTo(rows.map(([name, ...ids]) => ({ name, candidates: ids.map((id) => ({ id, name: id })) })));
    const firsts = got.map((g) => g.moveTo[0]?.id);
    assert.ok(firsts.every(Boolean), JSON.stringify(got));
    assert.equal(new Set(firsts).size, rows.length, JSON.stringify(firsts));
  });
}

test("review: the allocator still seats the earlier (worse) meeting when not everyone can be seated", () => {
  const got = allocateMoveTo([{ name: "A", candidates: [{ id: "X", name: "X" }] }, { name: "B", candidates: [{ id: "X", name: "X" }] }]);
  assert.equal(got[0]!.moveTo[0]?.id, "X");
  assert.equal(got[1]!.moveTo.length, 0);
  assert.match(got[1]!.moveToNote ?? "", /suggested for A/);
});

// Codex review of cdd6d8e (MEDIUM, diagnose.ts:156): Zoom's documented profile keeps the location code under `basic`.
test("review: a room whose list row has no code still finds rooms nearby by its profile's basic.location_id", async () => {
  const client: ZoomRoomsClient = {
    ...fake([{ id: "r1", name: "Board Room", status: "In Meeting", health: "Critical" }, row("r2", "Room 402", "Available", "Healthy", "L4")]),
    getRoom: async () => ({ id: "r1", basic: { name: "Board Room", location_id: "L4" }, issues: [{ issue: "Camera disconnected", severity: "critical" }] }),
  };
  const d = await diagnoseRoom(client, "r1", NOW, undefined, undefined, { moveTo: true });
  assert.deepEqual(d.moveTo?.rooms.map((r) => r.name), ["Room 402"]);
});

test("review: get_rooms_needing_attention also finds rooms nearby by the profile's basic.location_id", async () => {
  const client: ZoomRoomsClient = {
    ...fake([{ id: "r1", name: "Board Room", status: "In Meeting", health: "Critical" }, row("r2", "Room 402", "Available", "Healthy", "L4")]),
    getRoom: async () => ({ id: "r1", basic: { name: "Board Room", location_id: "L4" }, issues: [{ issue: "Camera disconnected", severity: "critical" }] }),
  };
  const a = await roomsNeedingAttention(client, 15, NOW);
  assert.deepEqual((a.rooms[0] as any).moveTo.map((r: any) => r.name), ["Room 402"]);
});
