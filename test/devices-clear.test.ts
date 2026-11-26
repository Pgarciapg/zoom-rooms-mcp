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
