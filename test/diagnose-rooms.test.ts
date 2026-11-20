import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

const NOW = Date.parse("2026-03-28T17:00:00Z");
const floor4 = { building: "Building 1", floor: "4th Floor" };

/** A fake account: rows for listRooms, details and devices per room id. */
const account = (rows: any[], details: Record<string, any>, devices: Record<string, any[]>, overrides: Partial<ZoomRoomsClient> = {}): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms: rows }),
  getRoom: async (id) => {
    if (!(id in details)) throw new Error(`Zoom API 404 on /rooms/${id}`);
    return details[id];
  },
  getRoomDevices: async (id) => ({ devices: devices[id] ?? [] }),
  ...overrides,
});
const row = (id: string, status: string, health: string) => ({ id, name: id.toUpperCase(), status, health });
const detail = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), issues: [], ...extra });
const ok = [{ name: "Zoom Rooms Controller", device_type: "Controller", status: "Online", firmware: "5.17.0" }];

test("demo campus: 3 problem rooms, no shared cause, per-room list, not an all-clear", async () => {
  const d = await diagnoseRooms(new DemoZoomRoomsClient(), NOW);
  assert.equal(d.total, 32);
  assert.equal(d.needAttention, 3);
  assert.deepEqual(d.patterns, []);
  assert.match(d.summary, /^3 of 32 rooms need attention\. No shared cause across the rooms: each problem looks local/);
  assert.deepEqual(d.rooms.map((r) => [r.name, r.level, r.top]), [
    ["Conference 4B", "critical", "Room computer offline"],
    ["Boardroom East", "warning", "Shure MXA920 (Microphone): Offline"],
    ["Room 212", "warning", "Controller high CPU (92%)"],
  ]);
  assert.equal(d.allClear, false);
});

test("three room computers offline on one floor within minutes: one location group, first", async () => {
  const rows = [row("a", "Offline", "Critical"), row("b", "Offline", "Critical"), row("c", "Offline", "Critical"), row("d", "Available", "Warning")];
  const details = {
    a: detail("a", { location: floor4, last_online: "2026-03-28T09:20:00Z" }),
    b: detail("b", { location: floor4, last_online: "2026-03-28T09:24:00Z" }),
    c: detail("c", { location: floor4, last_online: "2026-03-28T09:27:00Z" }),
    d: detail("d", { location: { building: "Building 1", floor: "2nd Floor" }, issues: [{ issue: "Firmware update available", severity: "warning" }] }),
  };
  const d = await diagnoseRooms(account(rows, details, { a: ok, b: ok, c: ok, d: ok }), NOW);
  assert.equal(d.patterns.length, 1);
  const p = d.patterns[0]!;
  assert.equal(p.kind, "location-offline");
  assert.equal(p.title, "3 room computers offline on Building 1, 4th Floor, last online within 7 min of each other");
  assert.deepEqual(p.rooms, ["A", "B", "C"]);
  assert.match(p.check, /network switch and power that serve Building 1, 4th Floor/);
  assert.match(d.summary, /1 shared cause found; start with: 3 room computers offline on Building 1, 4th Floor/);
});

test("offline rooms on one floor hours apart are still grouped, without the same-event claim", async () => {
  const rows = [row("a", "Offline", "Critical"), row("b", "Offline", "Critical")];
  const details = { a: detail("a", { location: floor4, last_online: "2026-03-28T09:00:00Z" }), b: detail("b", { location: floor4, last_online: "2026-03-28T14:00:00Z" }) };
  const d = await diagnoseRooms(account(rows, details, { a: ok, b: ok }), NOW);
  assert.equal(d.patterns[0]!.title, "2 room computers offline on Building 1, 4th Floor");
});

test("the same camera model failing in two rooms, same firmware, is one model group", async () => {
  const rally = (status: string) => [{ name: "Logitech Rally", device_type: "Camera", status, firmware: "1.8.230" }];
  const rows = [row("a", "Available", "Warning"), row("b", "Available", "Warning"), row("c", "Available", "Warning")];
  const details = { a: detail("a"), b: detail("b"), c: detail("c", { issues: [{ issue: "Controller high CPU (92%)", severity: "warning" }] }) };
  const d = await diagnoseRooms(account(rows, details, { a: rally("Disconnected"), b: rally("Offline"), c: ok }), NOW);
  assert.deepEqual(d.patterns.map((p) => [p.kind, p.title, p.rooms]), [["same-model", "Logitech Rally (Camera) failing in 2 rooms, all on firmware 1.8.230", ["A", "B"]]]);
});

test("different mic models on one firmware: a firmware group; generic device names are not a model", async () => {
  const rows = [row("a", "Available", "Warning"), row("b", "Available", "Warning")];
  const devices = {
    a: [{ name: "Shure MXA920", device_type: "Microphone", status: "Offline", firmware: "4.6.12" }, { name: "Display", device_type: "Display", status: "No signal" }],
    b: [{ name: "Shure MXA710", device_type: "Microphone", status: "Offline", firmware: "4.6.12" }, { name: "Display", device_type: "Display", status: "No signal" }],
  };
  const d = await diagnoseRooms(account(rows, { a: detail("a"), b: detail("b") }, devices), NOW);
  const kinds = d.patterns.map((p) => p.kind).sort();
  assert.deepEqual(kinds, ["same-firmware", "same-problem"]);
  assert.equal(d.patterns.find((p) => p.kind === "same-firmware")!.title, "2 failing microphones on firmware 4.6.12 across 2 rooms");
  assert.equal(d.patterns.find((p) => p.kind === "same-problem")!.title, "Display problems in 2 rooms");
});

test("a same-problem group is not repeated when a model group already names the same rooms", async () => {
  const rally = [{ name: "Logitech Rally", device_type: "Camera", status: "Disconnected", firmware: "1.8.230" }];
  const rows = [row("a", "Available", "Warning"), row("b", "Available", "Warning")];
  const d = await diagnoseRooms(account(rows, { a: detail("a"), b: detail("b") }, { a: rally, b: rally }), NOW);
  assert.deepEqual(d.patterns.map((p) => p.kind), ["same-model"]);
});

test("an unreadable room is listed as could not be read and blocks the all-clear", async () => {
  const rows = [row("a", "Available", "Warning"), row("gone", "Offline", "Critical")];
  const d = await diagnoseRooms(account(rows, { a: detail("a") }, { a: ok }, { getRoomDevices: async (id) => { if (id === "gone") throw new Error("Zoom API 404"); return { devices: ok }; } }), NOW);
  const gone = d.rooms.find((r) => r.id === "gone")!;
  assert.notEqual(gone.couldNotCheck, 0);
  assert.equal(d.allClear, false);
  assert.match(d.summary, /\nCould not check:\n/);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith("GONE: Room details: Zoom API 404")));
});

test("room list failure, empty account, unknown health: never an all-clear", async () => {
  const down = await diagnoseRooms(account([], {}, {}, { listRooms: async () => { throw new Error("Zoom rejected the token (401)."); } }), NOW);
  assert.equal(down.allClear, false);
  assert.match(down.summary, /^Could not read the room list/);
  const empty = await diagnoseRooms(account([], {}, {}), NOW);
  assert.equal(empty.allClear, false);
  assert.match(empty.summary, /no rooms to diagnose/);
  const odd = await diagnoseRooms(account([row("a", "Available", "Degraded")], {}, {}), NOW);
  assert.equal(odd.allClear, false);
  assert.match(odd.summary, /not an all-clear/);
});

test("all healthy is a real all-clear and diagnoses nothing", async () => {
  let detailCalls = 0;
  const d = await diagnoseRooms(account([row("a", "Available", "Healthy")], {}, {}, { getRoom: async () => { detailCalls++; return {}; } }), NOW);
  assert.equal(d.allClear, true);
  assert.equal(detailCalls, 0);
  assert.equal(d.summary, "All 1 rooms are healthy and none is offline.");
});

test("the detail cap names the rest, and the room list is read only once", async () => {
  let listCalls = 0;
  const rows = ["a", "b", "c"].map((id) => row(id, "Available", "Warning"));
  const base = account(rows, { a: { id: "a", name: "A", issues: [] }, b: { id: "b", name: "B", issues: [] }, c: { id: "c", name: "C", issues: [] } }, { a: ok, b: ok, c: ok });
  const d = await diagnoseRooms({ ...base, listRooms: async () => { listCalls++; return { rooms: rows }; } }, NOW, 2);
  assert.equal(listCalls, 1, "status and health come from the listed row");
  assert.deepEqual(d.notDiagnosed, ["C"]);
  assert.match(d.summary, /1 more problem room not diagnosed in this call: C\./);
});

test("over MCP: read-only, plain text, structured result", async () => {
  const server = createServer({ client: new DemoZoomRoomsClient(), source: "demo" });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "diagnose_rooms");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  assert.match(tool?.description ?? "", /demo data/);
  const r = (await client.callTool({ name: "diagnose_rooms", arguments: {} })) as any;
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /^3 of 32 rooms need attention/);
  assert.equal(r.structuredContent.view, "rooms-diagnosis");
  assert.equal(r.structuredContent.source, "demo");
});
