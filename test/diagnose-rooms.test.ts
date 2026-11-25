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
  assert.match(d.summary, /1 shared cause found across the rooms; start with: 3 room computers offline on Building 1, 4th Floor/);
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
  assert.equal(d.summary, "The 1 room is healthy and not offline.");
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

// Regressions from the adversarial review (2026-11-20).
const off = (id: string, location: unknown, last = "2026-03-28T09:20:00Z") => detail(id, { location, last_online: last });

test("review: rooms past the limit or unread are named in the no-shared-cause line", async () => {
  const rows = ["a", "b", "c"].map((id) => row(id, "Offline", "Critical"));
  const details = { a: off("a", floor4), b: off("b", floor4), c: off("c", floor4) };
  const d = await diagnoseRooms(account(rows, details, { a: ok, b: ok, c: ok }), NOW, 1);
  assert.match(d.summary, /No shared cause among the 1 room diagnosed: .* 2 problem rooms could not be included \(2 past the limit\), so a shared cause involving them would not show here\./);
});

test("review: a room listed twice counts once", async () => {
  const rows = [row("a", "Offline", "Critical"), row("a", "Offline", "Critical")];
  const d = await diagnoseRooms(account(rows, { a: off("a", floor4) }, { a: ok }), NOW);
  assert.equal(d.needAttention, 1);
  assert.deepEqual(d.patterns, []);
});

test("review: partial locations never group; case and spacing do not split a place; text and id locations work", async () => {
  const partial = await diagnoseRooms(account([row("a", "Offline", "Critical"), row("b", "Offline", "Critical")], { a: off("a", { floor: "2nd Floor" }), b: off("b", { floor: "2nd Floor" }) }, { a: ok, b: ok }), NOW);
  assert.deepEqual(partial.patterns, []);
  const cased = await diagnoseRooms(account([row("a", "Offline", "Critical"), row("b", "Offline", "Critical")], { a: off("a", { building: "HQ", floor: "2nd Floor" }), b: off("b", { building: "hq", floor: "2nd  floor" }) }, { a: ok, b: ok }), NOW);
  assert.equal(cased.patterns.length, 1);
  const text = await diagnoseRooms(account([row("a", "Offline", "Critical"), row("b", "Offline", "Critical")], { a: off("a", "HQ 2nd"), b: off("b", "HQ 2nd") }, { a: ok, b: ok }), NOW);
  assert.match(text.patterns[0]!.title, /offline on HQ 2nd/);
  const listId = await diagnoseRooms(account([{ ...row("a", "Offline", "Critical"), location_id: "L1" }, { ...row("b", "Offline", "Critical"), location_id: "L1" }], { a: off("a", {}), b: off("b", {}) }, { a: ok, b: ok }), NOW);
  assert.match(listId.patterns[0]!.title, /offline on L1/);
});

test("review: model groups need real failures, a real model name, matching firmware, and skip offline rooms", async () => {
  const two = (devA: any, devB: any, status = "Available", health = "Warning") =>
    diagnoseRooms(account([row("a", status, health), row("b", status, health)], { a: off("a", { building: "X", floor: "1" }), b: off("b", { building: "Y", floor: "2" }) }, { a: [devA], b: [devB] }), NOW);
  const rally = (extra: any) => ({ name: "Logitech Rally", device_type: "Camera", status: "Disconnected", ...extra });
  assert.doesNotMatch((await two(rally({ firmware: "1.0" }), rally({}))).patterns[0]!.title, /all on firmware/);
  assert.deepEqual((await two(rally({ status: "Updating" }), rally({ status: "Updating" }))).patterns, []);
  assert.ok(!(await two(rally({}), rally({}), "Offline", "Critical")).patterns.some((p) => p.kind === "same-model"));
  const cam1 = { name: "Camera 1", device_type: "Camera", status: "Offline", firmware: "1.0" };
  assert.ok(!(await two(cam1, { ...cam1, firmware: "9.9" })).patterns.some((p) => p.kind === "same-model"));
  const na = await two({ name: "Logitech Rally", device_type: "Camera", status: "Offline", firmware: "N/A" }, { name: "Poly Studio", device_type: "Camera", status: "Offline", firmware: "N/A" });
  assert.ok(!na.patterns.some((p) => p.kind === "same-firmware"));
  const cased = await two(rally({}), rally({ name: "logitech  rally" }));
  assert.deepEqual(cased.patterns.map((p) => p.kind), ["same-model"]);
});

test("review: two rooms with the same name are still two rooms", async () => {
  const rally = [{ name: "Logitech Rally", device_type: "Camera", status: "Disconnected" }];
  const rows = [{ ...row("1", "Available", "Warning"), name: "Huddle" }, { ...row("2", "Available", "Warning"), name: "Huddle" }];
  const d = await diagnoseRooms(account(rows, { 1: detail("1", { name: "Huddle" }), 2: detail("2", { name: "Huddle" }) }, { 1: rally, 2: rally }), NOW);
  assert.deepEqual(d.patterns[0]?.roomIds, ["1", "2"]);
});

test("review: 'Microsoft' and 'Michigan' are not microphones", async () => {
  const rows = [row("a", "Available", "Warning"), row("b", "Available", "Warning")];
  const details = { a: detail("a", { issues: [{ issue: "Microsoft Teams sign-in failed", severity: "warning" }] }), b: detail("b", { issues: [{ issue: "Michigan dial plan error", severity: "warning" }] }) };
  const d = await diagnoseRooms(account(rows, details, { a: ok, b: ok }), NOW);
  assert.deepEqual(d.patterns, []);
});

test("review: more pages, unreadable list entries, or an odd status block the all-clear", async () => {
  const healthy = row("a", "Available", "Healthy");
  const paged = await diagnoseRooms({ ...account([healthy], {}, {}), listRooms: async () => ({ rooms: [healthy], next_page_token: "abc" }) }, NOW);
  assert.equal(paged.allClear, false);
  assert.ok(paged.couldNotCheck.includes("Room list: Zoom has more pages of rooms than were read."));
  const junk = await diagnoseRooms(account([healthy, null, "x"], {}, {}), NOW);
  assert.equal(junk.allClear, false);
  assert.ok(junk.couldNotCheck.includes("Room list: 2 entries could not be read."));
  const odd = await diagnoseRooms(account([row("a", "Unknown", "Healthy")], {}, {}), NOW);
  assert.equal(odd.allClear, false);
});

test("review: grammar for one room", async () => {
  const d = await diagnoseRooms(account([row("a", "Available", "Warning")], { a: detail("a") }, { a: ok }), NOW);
  assert.match(d.summary, /^1 of 1 room needs attention\./);
});

test("documented device rows (device_hostname, device_firmware) still form a same-model group with their firmware", async () => {
  const cam = { device_hostname: "Logitech Rally", device_type: "Camera", status: "Disconnected", device_firmware: "1.4.3" };
  const r = await diagnoseRooms(account([row("a", "Available", "Warning"), row("b", "Available", "Warning")], { a: detail("a"), b: detail("b") }, { a: [cam], b: [cam] }), NOW);
  const p = r.patterns.find((x: any) => x.kind === "same-model");
  assert.ok(p, JSON.stringify(r.patterns));
  assert.match(p!.title, /Logitech Rally \(Camera\) failing in 2 rooms, all on firmware 1\.4\.3/);
});

// Codex review of b4974a8 (HIGH): Zoom's documented room list has no health field.
test("an Available room with no health field whose controller is Offline is diagnosed, not skipped", async () => {
  const rows = [{ id: "br", name: "Boardroom", status: "Available" }, { id: "q", name: "Quiet", status: "Available" }];
  const devs = { br: [{ name: "Zoom Rooms Controller", device_type: "Controller", status: "Offline" }], q: ok };
  const d = await diagnoseRooms(account(rows, { br: detail("br"), q: detail("q") }, devs), NOW);
  assert.equal(d.needAttention, 1, d.summary);
  assert.match(d.summary, /\(id br\): warning, 1 finding; first: Zoom Rooms Controller \(Controller\): Offline/);
  assert.doesNotMatch(d.summary, /\(id q\)/);
});

test("review: a critical room found by reading a no-health room is listed before warning rooms", async () => {
  const rows = [row("w1", "Available", "Warning"), { id: "nh", name: "NH", status: "Available" }];
  const devs = { w1: ok, nh: [{ name: "Rally", device_type: "Camera", status: "Offline" }] };
  const details = { w1: detail("w1", { issues: [{ issue: "Controller high CPU (92%)", severity: "warning" }] }), nh: detail("nh", { issues: [{ issue: "Camera disconnected", severity: "critical" }] }) };
  const d = await diagnoseRooms(account(rows, details, devs), NOW);
  assert.deepEqual(d.rooms.map((r) => r.id), ["nh", "w1"], d.summary);
});

test("review: a no-health room that could not be read says so; one read cleanly is not flagged", async () => {
  const rows = [{ id: "bad", name: "Bad", status: "Available" }, { id: "good", name: "Good", status: "Available" }];
  const d = await diagnoseRooms(account(rows, { good: detail("good") }, { good: ok }, { getRoomDevices: async (id) => { if (id === "bad") throw new Error("Zoom API 500"); return { devices: ok }; } }), NOW);
  const text = d.couldNotCheck.join(" | ");
  assert.match(text, /BAD|Bad/);
  assert.match(text, /could not be read/);
  assert.doesNotMatch(text, /GOOD: Zoom gives no health and/);
  assert.equal(d.allClear, false);
});

test("review: no-health rooms past the limit are counted as not read", async () => {
  const rows = ["a", "b", "c"].map((id) => ({ id, name: id, status: "Available" }));
  const d = await diagnoseRooms(account(rows, { a: detail("a"), b: detail("b"), c: detail("c") }, { a: ok, b: ok, c: ok }), NOW, 2);
  assert.match(d.couldNotCheck.join(" | "), /1 more room with no health from Zoom was not read/);
});
