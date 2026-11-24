// Same-named problem rooms in diagnose_room's "also in a meeting" line (2026-11-24). Two problem rooms named "Lobby"
// read "Lobby, Lobby", and one named like the diagnosed room read as the room itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRoom } from "../src/diagnose.ts";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const row = (id: string, name: string, status: string, health: string) => ({ id, name, status, health, location_id: "L1" });
const fake = (rooms: unknown[]): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id: string) => (id === "r1" ? { id: "r1", name: "Lobby", status: "In Meeting", health: "Critical", location_id: "L1", issues: [{ issue: "Camera disconnected", severity: "critical" }] } : { id }),
  getRoomDevices: async () => ({ devices: [] }),
});
const run = (rooms: unknown[]) => diagnoseRoom(fake(rooms), "r1", NOW, undefined, undefined, { moveTo: true });
const me = row("r1", "Lobby", "In Meeting", "Critical");
const spare = row("f1", "Huddle", "Available", "Healthy");

test("two other problem rooms with one name are told apart by their Zoom ids", async () => {
  const d = await run([me, spare, row("a1", "Atrium", "In Meeting", "Warning"), row("a2", "Atrium", "In Meeting", "Critical")]);
  assert.match(d.summary, /2 other problem rooms here \(Atrium \(Zoom room a1\), Atrium \(Zoom room a2\)\) are also in a meeting/);
});

test("another problem room named like this one is not read as this room", async () => {
  const d = await run([me, spare, row("r9", "Lobby", "In Meeting", "Warning")]);
  assert.match(d.summary, /Another problem room here, Lobby \(Zoom room r9\), is also in a meeting/);
});

test("different names read as before, and one room listed twice is one rival", async () => {
  const d = await run([me, spare, row("a1", "Atrium", "In Meeting", "Warning"), row("a1", "Atrium", "In Meeting", "Warning")]);
  assert.match(d.summary, /Another problem room here, Atrium, is also in a meeting/);
});

// From the Sonnet review (2026-11-24).
test("review: the attention list labels same-named problem rooms with the same Zoom ids", async () => {
  const { roomsNeedingAttention } = await import("../src/attention.ts");
  const a = await roomsNeedingAttention(fake([row("a1", "Atrium", "Offline", "Critical"), row("a2", "Atrium", "Offline", "Critical"), row("b1", "Board", "Offline", "Critical")]), undefined, NOW);
  assert.match(a.summary, /\] Atrium \(Zoom room a1\): Offline/);
  assert.match(a.summary, /\] Atrium \(Zoom room a2\): Offline/);
  assert.match(a.summary, /\] Board: Offline/);
});

test("review: same-named rivals with no id say so", async () => {
  const noId = (name: string) => ({ name, status: "In Meeting", health: "Warning", location_id: "L1" });
  const d = await run([me, spare, noId("Atrium"), noId("Atrium")]);
  assert.match(d.summary, /Atrium \(no Zoom id\), Atrium \(no Zoom id\)/);
});
