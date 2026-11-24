// The problem room's own seats beside the suggestion (2026-11-24). Without a meeting size, "move it to Huddle (seats 4)"
// did not say the meeting is in a 12-seat room. Now a smaller suggestion says so. Two rooms compared, never a fit claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoomRoomsClient } from "../src/client.ts";
import { diagnoseRoom } from "../src/diagnose.ts";
import { roomsNeedingAttention } from "../src/attention.ts";

const NOW = Date.parse("2026-11-24T15:00:00Z");
const broken = { id: "r1", name: "Board Room", status: "In Meeting", health: "Critical", location_id: "L4" };
const free = (id: string, name: string) => ({ id, name, status: "Available", health: "Healthy", location_id: "L4" });

/** r1 is broken and in a meeting, with `own` seats (or none); `seats` gives free rooms' seats. */
const fake = (rooms: unknown[], own: number | null, seats: Record<string, number> = {}): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id: string) =>
    id === "r1"
      ? { ...broken, issues: [{ issue: "Camera disconnected", severity: "critical" }], ...(own == null ? {} : { basic: { capacity: own } }) }
      : seats[id] == null ? { id } : { id, basic: { capacity: seats[id] } },
  getRoomDevices: async () => ({ devices: [{ name: "Rally Camera", device_type: "Camera", status: "Disconnected" }] }),
});
const diagnose = (c: ZoomRoomsClient, attendees?: number) => diagnoseRoom(c, "r1", NOW, undefined, undefined, { moveTo: true, attendees });

test("diagnose_room: a smaller suggestion says it has fewer seats than the problem room", async () => {
  const d = await diagnose(fake([broken, free("r2", "Huddle")], 12, { r2: 4 }));
  assert.equal(d.room?.seats, 12);
  assert.match(d.summary, /move it to Huddle \(seats 4, fewer than the 12 here; capacity not compared: no meeting size given\)/);
});

test("diagnose_room: an equal or bigger suggestion names this room's seats", async () => {
  const d = await diagnose(fake([broken, free("r2", "Room 405")], 12, { r2: 12 }));
  assert.match(d.summary, /move it to Room 405 \(seats 12, this room seats 12; capacity not compared/);
});

test("diagnose_room: with a meeting size the fit decides, and the own-room hint is not added", async () => {
  const d = await diagnose(fake([broken, free("r2", "Huddle")], 12, { r2: 4 }), 3);
  assert.match(d.summary, /move it to Huddle \(seats 4, fits 3 people\)/);
  assert.doesNotMatch(d.summary, /here/);
});

test("diagnose_room: no own seats in Zoom reads as before", async () => {
  const d = await diagnose(fake([broken, free("r2", "Huddle")], null, { r2: 4 }));
  assert.equal(d.room?.seats, null);
  assert.match(d.summary, /move it to Huddle \(seats 4; capacity not compared: no meeting size given\)/);
});

test("attention list: smaller and bigger suggestions, and unknown own seats", async () => {
  const smaller = await roomsNeedingAttention(fake([broken, free("r2", "Huddle")], 12, { r2: 4 }), undefined, NOW);
  assert.equal(smaller.rooms[0]?.seats, 12);
  assert.match(smaller.summary, /move it to Huddle \(seats 4, fewer than the 12 here, capacity not compared\)/);
  const bigger = await roomsNeedingAttention(fake([broken, free("r2", "Room 405")], 8, { r2: 14 }), undefined, NOW);
  assert.match(bigger.summary, /move it to Room 405 \(seats 14, this room seats 8, capacity not compared\)/);
  const unknown = await roomsNeedingAttention(fake([broken, free("r2", "Huddle")], null, { r2: 4 }), undefined, NOW);
  assert.match(unknown.summary, /move it to Huddle \(seats 4, capacity not compared\)/);
});
