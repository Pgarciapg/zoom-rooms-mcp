import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ago, diagnoseRoom, diagnosisText } from "../src/diagnose.ts";
import { DemoZoomRoomsClient, ZoomApiError, type ZoomRoomsClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

const NOW = Date.parse("2026-03-28T17:00:00Z");
const demo = () => new DemoZoomRoomsClient();
const fake = (detail: unknown, devices: unknown[], overrides: Partial<ZoomRoomsClient> = {}): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms: [] }),
  getRoom: async () => detail,
  getRoomDevices: async () => ({ devices }),
  ...overrides,
});
const room = (extra: Record<string, unknown> = {}) => ({ id: "r1", name: "R1", status: "Available", health: "Healthy", issues: [], ...extra });

test("demo offline room: computer first, then the camera issue and the disconnected camera as one finding", async () => {
  const d = await diagnoseRoom(demo(), "rm-001", NOW);
  assert.equal(d.room?.name, "Conference 4B");
  assert.equal(d.room?.where, "Building 1, 4th Floor");
  assert.deepEqual(d.findings.map((f) => [f.level, f.subject]), [
    ["critical", "Room computer offline"],
    ["critical", "Logitech Rally (Camera): Disconnected"],
  ]);
  assert.match(d.findings[0]!.detail, /last online 2026-03-28T09:20:00Z, about 8 h ago/);
  assert.match(d.findings[1]!.detail, /^Open issue: USB camera disconnected \(since 2026-03-28T09:22:00Z\)\. The room computer is offline too/);
  assert.match(d.findings[1]!.check, /Reseat the camera's USB/);
  assert.equal(d.allClear, false);
  assert.match(d.summary, /^Conference 4B \(Building 1, 4th Floor\): 2 critical\. Start with Room computer offline: Check the room computer's power/);
  assert.equal(d.devices.length, 4);
});

test("demo warning rooms: the mic issue joins the offline Shure; the CPU issue stands alone", async () => {
  const mic = await diagnoseRoom(demo(), "rm-002", NOW);
  assert.deepEqual(mic.findings.map((f) => [f.level, f.subject]), [["warning", "Shure MXA920 (Microphone): Offline"]]);
  assert.match(mic.findings[0]!.detail, /^Open issue: Microphone offline/);
  assert.match(mic.findings[0]!.check, /PoE/);
  const cpu = await diagnoseRoom(demo(), "room-212", NOW);
  assert.equal(cpu.room?.id, "rm-003");
  assert.deepEqual(cpu.findings.map((f) => f.subject), ["Controller high CPU (92%)"]);
  assert.match(cpu.findings[0]!.check, /Restart the controller/);
});

test("demo healthy room is a real all-clear, and a meeting in progress is called out", async () => {
  const d = await diagnoseRoom(demo(), "rm-005", NOW);
  assert.equal(d.allClear, true);
  assert.equal(d.room?.inMeeting, true);
  assert.equal(d.summary, "Huddle B (bldg-1-floor-1): all clear. Health is Healthy, the room computer is In Meeting, and all 2 devices are online. A meeting is running in it right now: fix after it ends.");
});

test("unknown room: a clear could-not-check, never a made-up room", async () => {
  const d = await diagnoseRoom(demo(), "nope-999", NOW);
  assert.equal(d.room, null);
  assert.equal(d.allClear, false);
  assert.match(d.summary, /^Could not check room nope-999: Room not found: nope-999\..*This is not an all-clear\.$/);
});

test("devices unreadable: no findings is still not an all-clear", async () => {
  const d = await diagnoseRoom(fake(room(), [], { getRoomDevices: async () => { throw new ZoomApiError(429, "Zoom API 429: rate limited"); } }), "r1", NOW);
  assert.deepEqual(d.findings, []);
  assert.deepEqual(d.couldNotCheck, ["Devices: Zoom API 429: rate limited"]);
  assert.equal(d.allClear, false);
  assert.match(d.summary, /^R1: no problems found in what could be read, but not everything could be checked \(1\)\. This is not an all-clear\.$/);
});

test("an empty device list is not an all-clear", async () => {
  const d = await diagnoseRoom(fake(room(), []), "r1", NOW);
  assert.equal(d.allClear, false);
  assert.deepEqual(d.couldNotCheck, ["Devices: Zoom listed no devices for this room, so none could be checked."]);
});

test("unknown or missing health blocks the all-clear", async () => {
  const d = await diagnoseRoom(fake(room({ health: "Degraded" }), []), "r1", NOW);
  assert.equal(d.allClear, false);
  assert.match(d.couldNotCheck[0]!, /Health: "Degraded"/);
});

test("health Warning with nothing to explain it becomes one finding, not an all-clear", async () => {
  const d = await diagnoseRoom(fake(room({ health: "Warning" }), [{ name: "Cam", device_type: "Camera", status: "Online" }]), "r1", NOW);
  assert.deepEqual(d.findings.map((f) => [f.level, f.subject]), [["warning", "Health is Warning with no open issue"]]);
  assert.equal(d.allClear, false);
});

test("a failing device with no issue, and an issue with no failing device, stay separate", async () => {
  const d = await diagnoseRoom(
    fake(room({ health: "Warning", issues: [{ issue: "Firmware update available", severity: "warning", since: "2026-03-20T00:00:00Z" }] }), [
      { name: "Panel", device_type: "Display", status: "No signal" },
      { name: "Cam", device_type: "Camera", status: "Online" },
    ]),
    "r1",
    NOW,
  );
  assert.deepEqual(d.findings.map((f) => f.subject).sort(), ["Firmware update available", "Panel (Display): No signal"]);
  const panel = d.findings.find((f) => f.subject.startsWith("Panel"))!;
  assert.match(panel.detail, /No open issue names it/);
  assert.match(panel.check, /HDMI/);
});

test("one issue joins at most one device: two offline mics with one mic issue give two findings", async () => {
  const d = await diagnoseRoom(
    fake(room({ health: "Warning", issues: [{ issue: "Microphone offline", severity: "warning" }] }), [
      { name: "Mic 1", device_type: "Microphone", status: "Offline" },
      { name: "Mic 2", device_type: "Microphone", status: "Offline" },
    ]),
    "r1",
    NOW,
  );
  assert.equal(d.findings.length, 2);
  assert.equal(d.findings.filter((f) => f.detail.startsWith("Open issue")).length, 1);
});

test("critical sorts before warning, oldest first within a level", async () => {
  const d = await diagnoseRoom(
    fake(room({ health: "Critical", issues: [
      { issue: "Late warning", severity: "warning", since: "2026-03-28T10:00:00Z" },
      { issue: "Early warning", severity: "warning", since: "2026-03-27T10:00:00Z" },
      { issue: "Big problem", severity: "critical", since: "2026-03-28T12:00:00Z" },
    ] }), []),
    "r1",
    NOW,
  );
  assert.deepEqual(d.findings.map((f) => f.subject), ["Big problem", "Early warning", "Late warning"]);
});

test("status and health come from the room list when the detail lacks them", async () => {
  const d = await diagnoseRoom(
    fake({ id: "r9", name: "Nine", issues: [] }, [], { listRooms: async () => ({ rooms: [{ id: "r9", name: "Nine", status: "Offline", health: "Critical" }] }) }),
    "r9",
    NOW,
  );
  assert.equal(d.room?.status, "Offline");
  assert.equal(d.findings[0]?.subject, "Room computer offline");
  const missing = await diagnoseRoom(fake({ id: "r9", name: "Nine", issues: [] }, [], { listRooms: async () => { throw new Error("Zoom API 500"); } }), "r9", NOW);
  assert.equal(missing.allClear, false);
  assert.ok(missing.couldNotCheck.some((c) => c.startsWith("Status and health (room list): Zoom API 500")));
});

test("ago: hours, days, and nothing for bad or future times", () => {
  assert.equal(ago("2026-03-28T16:30:00Z", NOW), "under an hour");
  assert.equal(ago("2026-03-28T09:20:00Z", NOW), "about 8 h");
  assert.equal(ago("2026-03-20T17:00:00Z", NOW), "about 8 days");
  assert.equal(ago("not a date", NOW), null);
  assert.equal(ago("2026-04-01T00:00:00Z", NOW), null);
  assert.equal(ago(null, NOW), null);
});

test("over MCP: read-only tool, plain text with findings and devices, structured diagnosis", async () => {
  const server = createServer({ client: demo(), source: "demo" });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "diagnose_room");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  assert.match(tool?.description ?? "", /demo data/);
  const r = (await client.callTool({ name: "diagnose_room", arguments: { roomId: "rm-001" } })) as any;
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /^Conference 4B .*\n\nFindings, worst first:\n1\. \[critical\] Room computer offline/s);
  assert.match(r.content[0].text, /\nDevices:\n- Logitech Rally \(Camera\): Disconnected, firmware 1\.8\.230/);
  assert.equal(r.structuredContent.source, "demo");
  assert.equal(r.structuredContent.view, "room-diagnosis");
  assert.equal(r.structuredContent.findings.length, 2);
});

test("diagnosisText lists could-not-check last", async () => {
  const d = await diagnoseRoom(fake(room(), [], { getRoomDevices: async () => { throw new Error("boom"); } }), "r1", NOW);
  assert.match(diagnosisText(d), /\n\nCould not check:\n- Devices: boom$/);
});
