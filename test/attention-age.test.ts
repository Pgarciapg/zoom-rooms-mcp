// How long (2026-11-23, 1:30 relay). The "start here" attention list printed raw times ("last online
// 2026-11-20T09:00:00Z", "since 2026-11-23T16:00:00Z") with no age, while diagnose_room said "about 3 days". A room
// offline for minutes and one offline for days read the same. Now the list uses diagnose_room's own age rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomsNeedingAttention } from "../src/attention.ts";
import { ago } from "../src/diagnose.ts";
import { attentionCard } from "../src/card-model.ts";
import type { ZoomRoomsClient } from "../src/client.ts";

const NOW = Date.parse("2026-11-23T17:00:00Z");
const client = (rooms: Record<string, unknown>[], details: Record<string, Record<string, unknown>>): ZoomRoomsClient => ({
  listRooms: async () => ({ rooms }),
  getRoom: async (id: string) => ({ ...rooms.find((r) => r.id === id), ...details[id] }),
  getRoomDevices: async () => ({ devices: [] }),
});

test("an offline room says how long ago it was last online, using diagnose_room's rule", async () => {
  const a = await roomsNeedingAttention(
    client([{ id: "o1", name: "Board Room", status: "Offline", health: "Critical" }], { o1: { last_online: "2026-11-20T09:00:00Z" } }),
    undefined,
    NOW,
  );
  assert.equal(ago("2026-11-20T09:00:00Z", NOW), "about 3 days");
  assert.match(a.rooms[0]!.next, /^The room computer is offline \(last online 2026-11-20T09:00:00Z, about 3 days ago\): /);
  assert.match(a.summary, /Next: The room computer is offline \(last online 2026-11-20T09:00:00Z, about 3 days ago\)/);
});

test("an open issue says how long it has been open, in the text and on the card", async () => {
  const a = await roomsNeedingAttention(
    client([{ id: "w1", name: "Huddle 4", status: "Available", health: "Warning" }], { w1: { issues: [{ issue: "Camera disconnected", severity: "warning", since: "2026-11-23T14:00:00Z" }] } }),
    undefined,
    NOW,
  );
  assert.equal(a.rooms[0]!.issues[0]!.age, "about 3 h");
  assert.match(a.summary, /Issue: Camera disconnected \(since 2026-11-23T14:00:00Z, about 3 h ago\)\./);
  const card = JSON.stringify(attentionCard(a, "live" as never));
  assert.match(card, /"age":"about 3 h"/);
});

test("a missing, unreadable or future time shows no age, and the text is as before", async () => {
  const a = await roomsNeedingAttention(
    client(
      [
        { id: "o1", name: "A", status: "Offline", health: "Critical" },
        { id: "o2", name: "B", status: "Offline", health: "Critical" },
        { id: "w1", name: "C", status: "Available", health: "Warning" },
      ],
      {
        o1: { last_online: "not a date" },
        o2: { last_online: "2026-11-24T09:00:00Z" },
        w1: { issues: [{ issue: "Mic offline", since: "yesterday-ish" }, { issue: "Speaker offline" }] },
      },
    ),
    undefined,
    NOW,
  );
  const by = Object.fromEntries(a.rooms.map((r) => [r.name, r]));
  assert.match(by.A!.next, /^The room computer is offline \(last online not a date\): /);
  assert.match(by.B!.next, /^The room computer is offline \(last online 2026-11-24T09:00:00Z\): /);
  assert.deepEqual(by.C!.issues.map((i) => i.age), [null, null]);
  assert.match(a.summary, /Issue: Mic offline \(since yesterday-ish\)\./);
  assert.match(a.summary, /Issue: Speaker offline\./);
});
