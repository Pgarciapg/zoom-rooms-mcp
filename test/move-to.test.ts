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

test("names free, healthy rooms in the same place, and never busy, offline, unhealthy, unknown or other-floor rooms", async () => {
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
  assert.deepEqual(d.moveTo, { rooms: [{ id: "r3", name: "Room 401" }, { id: "r2", name: "Room 402" }], more: 0, note: null });
  assert.match(d.summary, /A meeting is running in it right now: fix after it ends, or move it to Room 401, free now in the same Zoom location\./);
  assert.match(diagnosisText(d), /Free now in the same Zoom location, healthy and not in a meeting: Room 401 \(r3\), Room 402 \(r2\)\./);
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
