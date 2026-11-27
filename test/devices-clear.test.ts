// 11/26: on a real account (Zoom's documented room list has no health, its room profile has no issues list) neither
// get_rooms_needing_attention nor diagnose_rooms could ever say anything reassuring, even after reading every room.
// Now a clean read gives an honest "devices clear" answer, never a full all-clear while alerts are unread.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ZoomRoomsClient } from "../src/client.ts";
import { roomsNeedingAttention } from "../src/attention.ts";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";

const NOW = Date.parse("2026-11-26T15:00:00Z");
const online = [{ id: "c", name: "Controller", device_type: "Controller", status: "Online" }];
/** The documented shapes: list rows without health, profiles under `basic` with no `issues`. */
const live = (n: number, over: Partial<ZoomRoomsClient> = {}): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms: Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Room ${i}`, status: "Available" })), next_page_token: "" }),
  getRoom: async (id) => ({ id, basic: { name: id } }),
  getRoomDevices: async () => ({ devices: online }),
  ...over,
});

for (const [tool, run] of [
  ["diagnose_rooms", (c: ZoomRoomsClient) => diagnoseRooms(c, NOW)],
  ["get_rooms_needing_attention", (c: ZoomRoomsClient) => roomsNeedingAttention(c, 15, NOW)],
] as const) {
  test(`${tool}: a live account read cleanly says devices are clear, with one line about unread alerts`, async () => {
    const d: any = await run(live(4));
    assert.equal(d.allClear, false);
    assert.equal(d.devicesClear, true, d.summary);
    assert.match(d.summary, /All 4 rooms are up and every device Zoom listed is online/);
    assert.match(d.summary, /not a full all-clear/);
    assert.equal(d.couldNotCheck.length, 1, d.couldNotCheck.join(" | "));
    assert.match(d.couldNotCheck[0], /^4 rooms: Zoom gives no health or alerts/);
    assert.doesNotMatch(d.summary, /could not be classed as healthy/);
  });

  test(`${tool}: a device read that fails keeps devicesClear false`, async () => {
    const d: any = await run(live(3, { getRoomDevices: async (id) => { if (id === "r1") throw new Error("Zoom API 500"); return { devices: online }; } }));
    assert.equal(d.devicesClear, false);
    assert.equal(d.allClear, false);
  });

  test(`${tool}: an offline device still makes the room a problem`, async () => {
    const d: any = await run(live(2, { getRoomDevices: async (id) => ({ devices: id === "r1" ? [{ ...online[0], status: "Offline" }] : online }) }));
    assert.equal(d.devicesClear, false);
    assert.equal(d.needAttention, 1);
  });

  test(`${tool}: rooms past the read limit keep devicesClear false`, async () => {
    const d: any = await run(live(40));
    assert.equal(d.devicesClear, false);
    assert.equal(d.allClear, false);
  });

  test(`${tool}: a profile that does carry an empty issues list gives a real all-clear`, async () => {
    const d: any = await run(live(3, { getRoom: async (id) => ({ id, basic: { name: id }, issues: [] }) }));
    assert.equal(d.allClear, true, d.summary);
    assert.equal(d.devicesClear, false);
  });
}

// Sonnet review of 3844477 (11/26).
test("review: diagnose_rooms keeps the worse of two rows with one id, so a duplicate never gives devicesClear", async () => {
  const c = live(2, { listRooms: async () => ({ rooms: [{ id: "r0", name: "Room 0", status: "Available" }, { id: "r0", name: "Room 0", status: "Offline" }, { id: "r1", name: "Room 1", status: "Available" }], next_page_token: "" }) });
  const d = await diagnoseRooms(c, NOW);
  assert.equal(d.devicesClear, false);
  assert.equal(d.needAttention, 1, d.summary);
  assert.match(d.couldNotCheck.join(" | "), /room id r0 appeared twice/);
});

test("review: attention never calls devices clear when a room's own profile says it is offline", async () => {
  const d = await roomsNeedingAttention(live(2, { getRoom: async (id) => ({ id, basic: { name: id }, ...(id === "r1" ? { status: "Offline" } : {}) }) }), 15, NOW);
  assert.equal(d.devicesClear, false, d.summary);
});

test("review: a numeric next_page_token still marks the list partial in attention", async () => {
  const d = await roomsNeedingAttention(live(2, { listRooms: async () => ({ rooms: [{ id: "r0", name: "Room 0", status: "Available" }], next_page_token: 7 as any }) }), 15, NOW);
  assert.equal(d.devicesClear, false);
});

test("review: a Healthy-listed room with an odd status keeps devicesClear false", async () => {
  const c = live(2, { listRooms: async () => ({ rooms: [{ id: "r0", name: "Room 0", status: "Available" }, { id: "r1", name: "Room 1", status: "Unknown", health: "Healthy" }], next_page_token: "" }) });
  for (const d of [await roomsNeedingAttention(c, 15, NOW), await diagnoseRooms(c, NOW)]) assert.equal(d.devicesClear, false, d.summary);
});

// Sonnet review of f1e7dc7: a profile with `issues: null` gives the same honest "devices clear" answer.
test("diagnose_rooms: profiles with issues: null still give the devices-clear answer", async () => {
  const d: any = await diagnoseRooms(live(3, { getRoom: async (id) => ({ id, basic: { name: id }, issues: null }) }), NOW);
  assert.equal(d.allClear, false);
  assert.equal(d.devicesClear, true, d.summary);
});
