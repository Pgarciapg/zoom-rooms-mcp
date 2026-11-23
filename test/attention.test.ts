import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { roomsNeedingAttention, nextStep } from "../src/attention.ts";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

const demo = () => new DemoZoomRoomsClient();
const withRooms = (rooms: any[], overrides: Partial<ZoomRoomsClient> = {}): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id) => ({ id, issues: [] }),
  getRoomDevices: async () => ({ devices: [] }),
  ...overrides,
});

test("demo: 3 of 32 rooms, critical first, each with issues, failing devices and a next step", async () => {
  const a = await roomsNeedingAttention(demo());
  assert.equal(a.total, 32);
  assert.equal(a.needAttention, 3);
  assert.deepEqual(a.counts, { critical: 1, warning: 2 });
  assert.deepEqual(a.rooms.map((r) => [r.level, r.name]), [["critical", "Conference 4B"], ["warning", "Room 212"], ["warning", "Boardroom East"]]);
  assert.deepEqual(a.rooms[0]!.devices, ["Logitech Rally (Camera): Disconnected"]);
  assert.match(a.rooms[0]!.next, /^The room computer is offline \(last online 2026-03-28T09:20:00Z(, about [0-9,]+ days ago)?\).*Then: Reseat the camera/);
  assert.match(a.rooms[2]!.next, /microphone's network or PoE/);
  assert.equal(a.allClear, false);
  assert.match(a.summary, /^3 of 32 rooms need attention: 1 critical, 2 warning\./);
});

test("all healthy reads as a real all-clear", async () => {
  const a = await roomsNeedingAttention(withRooms([{ id: "a", name: "A", status: "Available", health: "Healthy" }, { id: "b", name: "B", status: "In Meeting", health: "Healthy" }]));
  assert.equal(a.allClear, true);
  assert.equal(a.summary, "All 2 rooms are healthy and none is offline.");
});

test("rooms in a meeting are flagged so nobody walks in mid-call", async () => {
  const a = await roomsNeedingAttention(withRooms([{ id: "m", name: "Meet", status: "In Meeting", health: "Warning" }]));
  assert.equal(a.rooms[0]!.inMeeting, true);
  assert.match(a.summary, /in a meeting right now \(fix after it ends\)/);
});

test("could not read: a failing room detail or an unknown health is never an all-clear", async () => {
  const unreadable = await roomsNeedingAttention(withRooms([{ id: "x", name: "X", status: "Available", health: "Warning" }], { getRoomDevices: async () => { throw new Error("Zoom API 429: rate limited"); } }));
  assert.deepEqual(unreadable.couldNotCheck, ["X devices: Zoom API 429: rate limited"]);
  assert.equal(unreadable.allClear, false);
  const odd = await roomsNeedingAttention(withRooms([{ id: "y", name: "Y", status: "Available", health: "" }]));
  assert.equal(odd.allClear, false);
  assert.match(odd.summary, /not an all-clear/);
  const down = await roomsNeedingAttention(withRooms([], { listRooms: async () => { throw new Error("Zoom rejected the token (401)."); } }));
  assert.match(down.summary, /^Could not read the room list: Zoom rejected the token \(401\)\./);
  assert.equal(down.allClear, false);
});

test("offline beats warning, and offline rooms lead within critical; the detail cap names the rest", async () => {
  const rooms = [
    { id: "w", name: "W", status: "Available", health: "Warning" },
    { id: "c", name: "C", status: "Available", health: "Critical" },
    { id: "o", name: "O", status: "Offline", health: "Healthy" },
  ];
  const a = await roomsNeedingAttention(withRooms(rooms), 2);
  assert.deepEqual(a.rooms.map((r) => r.name), ["O", "C"]);
  assert.match(a.summary, /1 more problem room not read in detail: W\./);
});

test("next steps: specific device rules, generic fallback", () => {
  const base = { status: "Available", lastOnline: null, devices: [] as string[] };
  assert.match(nextStep({ ...base, issues: [{ issue: "Controller high CPU (92%)", severity: "warning", since: null }] }), /Restart the controller/);
  assert.match(nextStep({ ...base, issues: [{ issue: "Something odd", severity: "warning", since: null }] }), /Zoom admin portal/);
});

test("over MCP: plain-English text, structured rooms, read-only", async () => {
  const server = createServer({ client: demo(), source: "demo" });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  const tool = (await client.listTools()).tools.find((t) => t.name === "get_rooms_needing_attention");
  assert.equal(tool?.annotations?.readOnlyHint, true);
  const r = (await client.callTool({ name: "get_rooms_needing_attention", arguments: {} })) as any;
  assert.match(r.content[0].text, /^3 of 32 rooms need attention/);
  assert.equal(r.structuredContent.source, "demo");
  assert.equal(r.structuredContent.rooms.length, 3);
});
