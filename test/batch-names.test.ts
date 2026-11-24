// diagnose_rooms with same-named problem rooms (2026-11-24): the "not diagnosed" list and the "could not check" lines
// printed bare names ("Lobby, Lobby"). They now carry Zoom's room id, as the other tools do.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const row = (id: string, name: string) => ({ id, name, status: "Available", health: "Warning" });
const client = (rows: any[], failDevices: string[] = []): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms: rows }),
  getRoom: async (id) => ({ id, name: rows.find((r) => r.id === id)?.name, issues: [{ issue: "Display disconnected", severity: "warning" }] }),
  getRoomDevices: async (id) => {
    if (failDevices.includes(id)) throw new Error("Zoom API 500");
    return { devices: [] };
  },
});

test("rooms past the limit with one name are told apart", async () => {
  const d = await diagnoseRooms(client([row("a", "Alpha"), row("l1", "Lobby"), row("l2", "Lobby")]), NOW, 1);
  assert.deepEqual(d.notDiagnosed, ["Lobby (Zoom room l1)", "Lobby (Zoom room l2)"]);
});

test("could-not-check lines for two rooms with one name are told apart", async () => {
  const d = await diagnoseRooms(client([row("l1", "Lobby"), row("l2", "Lobby")], ["l1", "l2"]), NOW);
  assert.ok(d.couldNotCheck.some((c) => c.startsWith("Lobby (Zoom room l1): ")), d.couldNotCheck.join(" | "));
  assert.ok(d.couldNotCheck.some((c) => c.startsWith("Lobby (Zoom room l2): ")), d.couldNotCheck.join(" | "));
});

test("different names read as before", async () => {
  const d = await diagnoseRooms(client([row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")], ["b"]), NOW, 1);
  assert.deepEqual(d.notDiagnosed, ["Beta", "Gamma"]);
});

// From the Sonnet review (2026-11-24).
test("review: the label comes from the room list, even when the detail gives another name", async () => {
  const rows = [row("l1", "Lobby"), row("l2", "Lobby")];
  const c: ZoomRoomsClient = { ...client(rows, ["l1", "l2"]), getRoom: async (id) => ({ id, name: id === "l1" ? "Lobby 1" : "Lobby", issues: [{ issue: "Display disconnected", severity: "warning" }] }) };
  const d = await diagnoseRooms(c, NOW);
  assert.ok(d.couldNotCheck.some((x) => x.startsWith("Lobby (Zoom room l1): ")), d.couldNotCheck.join(" | "));
  assert.ok(d.couldNotCheck.some((x) => x.startsWith("Lobby (Zoom room l2): ")), d.couldNotCheck.join(" | "));
});
