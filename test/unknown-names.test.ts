// diagnose_rooms, rooms whose health or status could not be classed (2026-11-24): their could-not-check lines printed
// bare names, so two rooms called "Lobby" (or one of them and a same-named problem room) could not be told apart.
// Every name shared by rooms that appear in the answer now carries Zoom's room id.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";

const NOW = Date.parse("2026-11-24T16:00:00Z");
const problem = (id: string, name: string) => ({ id, name, status: "Available", health: "Warning" });
const unknown = (id: string, name: string, health = "") => ({ id, name, status: "Available", health });
const healthy = (id: string, name: string) => ({ id, name, status: "Available", health: "Healthy" });
const client = (rows: any[]): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms: rows }),
  getRoom: async (id) => ({ id, name: rows.find((r) => r.id === id)?.name, issues: [{ issue: "Display disconnected", severity: "warning" }] }),
  getRoomDevices: async () => ({ devices: [] }),
});
const lines = (d: { couldNotCheck: string[] }) => d.couldNotCheck.join(" | ");

test("two unclassed rooms with one name are told apart", async () => {
  const d = await diagnoseRooms(client([unknown("u1", "Lobby"), unknown("u2", "Lobby", "Pending")]), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith('Lobby (Zoom room u1): health is "not reported"')), lines(d));
  assert.ok(d.couldNotCheck.some((c) => c.startsWith('Lobby (Zoom room u2): health is "Pending"')), lines(d));
});

test("an unclassed room and a problem room with one name are both told apart", async () => {
  const d = await diagnoseRooms(client([unknown("u1", "Lobby"), problem("p1", "Lobby")]), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith("Lobby (Zoom room u1): health is")), lines(d));
  assert.match(d.summary, /Lobby \(Zoom room p1\)|id p1/);
  assert.ok(!d.couldNotCheck.some((c) => c.startsWith("Lobby: ")), lines(d));
});

test("an unclassed room whose status is odd is told apart too", async () => {
  const rows = [{ id: "s1", name: "Lobby", status: "Weird", health: "Healthy" }, unknown("u2", "Lobby")];
  const d = await diagnoseRooms(client(rows), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith('Lobby (Zoom room s1): status is "Weird"')), lines(d));
});

test("a healthy twin does not add an id: only rooms named in the answer count", async () => {
  const d = await diagnoseRooms(client([unknown("u1", "Lobby"), healthy("h1", "Lobby")]), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith('Lobby: health is "not reported"')), lines(d));
});

test("a single unclassed room reads as before", async () => {
  const d = await diagnoseRooms(client([unknown("u1", "Lobby"), problem("p1", "Atrium")]), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith('Lobby: health is "not reported"')), lines(d));
});
