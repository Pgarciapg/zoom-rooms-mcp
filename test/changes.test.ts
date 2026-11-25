import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { accountFingerprint, compare, FileSnapshotStore, MemorySnapshotStore, nextSnapshot, readAccount, type SnapshotStore } from "../src/changes.ts";
import { createServer } from "../src/server.ts";

type Result = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
const NOW = Date.parse("2026-11-20T17:00:00Z");
const DAY = 86_400_000;

const connect = async (client: ZoomRoomsClient = new DemoZoomRoomsClient(), opts: { snapshots?: SnapshotStore; source?: "demo" | "zoom"; account?: string; now?: () => number } = {}) => {
  const server = createServer({ client, source: opts.source ?? "demo", cardHtml: null, snapshots: opts.snapshots, account: opts.account, now: opts.now ?? (() => NOW) });
  const c = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(a), server.connect(b)]);
  return c;
};
const call = async (c: Client, args: Record<string, unknown> = {}) => (await c.callTool({ name: "what_changed", arguments: args })) as Result;

/** A small fake account whose rooms, issues and devices a test can change between checks. */
const fakeAccount = () => {
  const state = {
    rooms: [
      { id: "r1", name: "Room One", status: "Available", health: "Healthy" },
      { id: "r2", name: "Room Two", status: "Available", health: "Warning" },
    ] as any[],
    issues: { r2: [{ issue: "Microphone offline" }] } as Record<string, any[]>,
    devices: { r2: [{ name: "Ceiling Mic", device_type: "Microphone", status: "Offline" }] } as Record<string, any[]>,
    nextToken: "",
    failDetail: new Set<string>(),
  };
  const client: ZoomRoomsClient = {
    listRooms: async () => ({ rooms: state.rooms, next_page_token: state.nextToken }),
    getRoom: async (id) => {
      if (state.failDetail.has(id)) throw new Error("timeout");
      return { ...state.rooms.find((r) => r.id === id), issues: state.issues[id] ?? [] };
    },
    getRoomDevices: async (id) => {
      if (state.failDetail.has(id)) throw new Error("timeout");
      return { devices: state.devices[id] ?? [{ name: "Controller", device_type: "Controller", status: "Online" }] };
    },
  };
  return { state, client };
};

test("demo: compares with the campus a day earlier, worst first, then says nothing changed", async () => {
  const c = await connect();
  const r = await call(c);
  assert.ok(!r.isError, r.content[0]!.text);
  const text = r.content[0]!.text;
  assert.equal(r.structuredContent.summary, "3 rooms changed, 2 for the worse since the last check (1 day ago).");
  assert.match(text, /Conference 4B:\n- \[worse\] Went offline \(was Available\)\./);
  assert.match(text, /New issue: USB camera disconnected \(the room was healthy at the last check\)/);
  assert.match(text, /Room 401:\n- \[better\] Health better: Healthy \(was Warning\)\.\n- \[better\] Issue closed: Display disconnected\.\n- \[better\] Display \(Display\): back online \(was Offline\)\./);
  assert.ok(text.indexOf("Conference 4B") < text.indexOf("Room 401"), "worse rooms come first");
  assert.doesNotMatch(text, /Boardroom East/, "an unchanged problem room is not a change");
  assert.match(text, /demo memory only \(nothing is written to disk\)/);
  const again = await call(c);
  assert.equal(again.structuredContent.summary, "Nothing changed since the last check (less than a minute ago).");
});

test("first run says there is nothing to compare and saves a starting point; save false keeps it", async () => {
  const { client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  const dry = await call(c, { save: false });
  assert.equal(dry.structuredContent.summary, "No previous check to compare against.");
  assert.equal(store.load(), null);
  await call(c);
  assert.deepEqual(Object.keys(store.load()!.rooms).sort(), ["r1", "r2"]);
});

test("issues, devices, status and health changes in both directions", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  let t = NOW;
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct", now: () => t });
  await call(c);
  state.rooms = [{ id: "r1", name: "Room One", status: "Offline", health: "Critical" }, { id: "r2", name: "Room Two", status: "Available", health: "Healthy" }];
  state.issues = { r1: [{ issue: "Camera disconnected" }], r2: [] };
  state.devices = { r1: [{ name: "Rally", device_type: "Camera", status: "Disconnected" }], r2: [{ name: "Ceiling Mic", device_type: "Microphone", status: "Online" }] };
  t = NOW + 2 * 3_600_000;
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.equal(r.structuredContent.summary, "2 rooms changed, 1 for the worse since the last check (2 hours ago).");
  assert.match(text, /Room One:\n- \[worse\] Went offline/);
  assert.match(text, /\[better\] Issue closed: Microphone offline\./);
  assert.match(text, /\[better\] Ceiling Mic \(Microphone\): back online \(was Offline\)\./);
});

test("a room whose detail could not be read is not compared, and its last reading is kept", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  const kept = store.load()!.rooms.r2!.detail;
  state.failDetail.add("r2");
  state.issues.r2 = [];
  const r = await call(c);
  assert.doesNotMatch(r.content[0]!.text, /Issue closed|back online/);
  assert.match(r.content[0]!.text, /Room Two: issues and devices could not be read \(timeout\)/);
  assert.match(r.structuredContent.summary, /^No changes in what could be compared/);
  assert.deepEqual(store.load()!.rooms.r2!.detail, kept);
});

test("a partial room list never calls rooms added or removed, and keeps missing rooms for later", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [state.rooms[1]];
  state.nextToken = "more";
  const r = await call(c);
  assert.doesNotMatch(r.content[0]!.text, /No longer in the account/);
  assert.match(r.content[0]!.text, /Room One: not in this check's room list, which was not read in full/);
  assert.ok(store.load()!.rooms.r1, "the unread room keeps its last reading");
  // A full list later can say it was removed.
  state.nextToken = "";
  const full = await call(c);
  assert.match(full.content[0]!.text, /Room One:\n- \[changed\] No longer in the account's room list/);
});

test("a new room is only called new between two full lists", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [...state.rooms, { id: "r3", name: "Room Three", status: "Available", health: "Healthy" }];
  const r = await call(c);
  assert.match(r.content[0]!.text, /Room Three:\n- \[changed\] New room in the account \(Available, Healthy\)\./);
});

test("a saved check from another account is refused, not compared or overwritten", async () => {
  const { client } = fakeAccount();
  const store = new MemorySnapshotStore();
  await call(await connect(client, { snapshots: store, source: "zoom", account: "acct-a" }));
  const before = JSON.stringify(store.load());
  const r = await call(await connect(client, { snapshots: store, source: "zoom", account: "acct-b" }));
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /different Zoom account/);
  assert.equal(JSON.stringify(store.load()), before);
  assert.equal(accountFingerprint("123").length, 16);
  assert.notEqual(accountFingerprint("123"), accountFingerprint("124"));
  assert.doesNotMatch(accountFingerprint("123"), /123/);
});

test("the file is private to its owner, and an unreadable file is kept aside", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zr-"));
  const path = join(dir, "sub", "last.json");
  const { client } = fakeAccount();
  const c = await connect(client, { snapshots: new FileSnapshotStore(path), source: "zoom", account: "acct" });
  await call(c);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
  writeFileSync(path, "{nope");
  const r = await call(c);
  assert.match(r.content[0]!.text, /could not be used: .*kept as .*unreadable-/s);
  const aside = readdirSync(join(dir, "sub")).find((f) => f.includes("unreadable-"))!;
  assert.equal(readFileSync(join(dir, "sub", aside), "utf8"), "{nope");
  writeFileSync(path, JSON.stringify({ version: 1, account: "acct", fullListAt: null, rooms: { r1: { list: { name: 5 } } } }));
  const bad = await call(c, { save: false });
  assert.equal(bad.isError, true);
});

test("pure compare: a room healthy last time with no detail read gets 'new' only for what it shows now", async () => {
  const { state, client } = fakeAccount();
  const first = await readAccount(client, null);
  const snap = nextSnapshot(first, null, "acct", NOW - DAY);
  assert.equal(snap.rooms.r1!.detail, undefined, "a healthy room not read in detail saves no detail");
  state.rooms[0] = { ...state.rooms[0], health: "Warning" };
  state.issues.r1 = [{ issue: "High CPU" }];
  const out = compare(await readAccount(client, snap), snap, NOW);
  assert.ok(out.changes.some((x) => x.text === "New issue: High CPU (the room was healthy at the last check)."));
});

// ---- regressions from the Sonnet adversarial review ----
test("review: a room list in an odd shape is an error, not every room removed; nothing is saved", async () => {
  for (const bad of [{ rooms: "x" }, {}, null, { error: "oops" }]) {
    const { client } = fakeAccount();
    const store = new MemorySnapshotStore();
    await call(await connect(client, { snapshots: store, source: "zoom", account: "acct" }));
    const before = JSON.stringify(store.load());
    const odd: ZoomRoomsClient = { ...client, listRooms: async () => bad };
    const r = await call(await connect(odd, { snapshots: store, source: "zoom", account: "acct" }));
    assert.equal(r.isError, true, JSON.stringify(bad));
    assert.match(r.content[0]!.text, /unexpected shape/);
    assert.equal(JSON.stringify(store.load()), before);
  }
});

test("review: an empty room list after a non-empty one is treated as incomplete", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [];
  const r = await call(c);
  assert.doesNotMatch(r.content[0]!.text, /No longer in the account/);
  assert.match(r.content[0]!.text, /Zoom returned no rooms, though there were rooms last time/);
  assert.equal(Object.keys(store.load()!.rooms).length, 2);
});

test("review: an unreadable or missing issues list is unknown, never 'Issue closed'", async () => {
  for (const variant of ["odd-issue", "no-issues"]) {
    const { state, client } = fakeAccount();
    const store = new MemorySnapshotStore();
    const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
    await call(c);
    state.rooms[1] = { ...state.rooms[1], health: "Healthy" };
    state.devices.r2 = [{ name: "Ceiling Mic", device_type: "Microphone", status: "Online" }];
    const shaped: ZoomRoomsClient = { ...client, getRoom: async (id) => (variant === "odd-issue" ? { id, issues: [{ issue_name: "Microphone offline" }] } : { id }) };
    const r = await call(await connect(shaped, { snapshots: store, source: "zoom", account: "acct" }));
    assert.doesNotMatch(r.content[0]!.text, /Issue closed/, variant);
    // Since 11/25 a profile with no issues list (Zoom's documented shape) still has its devices compared.
    if (variant === "odd-issue") assert.match(r.content[0]!.text, /Room Two: issues and devices could not be read/, variant);
    else assert.match(r.content[0]!.text, /Open issues for Room Two: Zoom's room profile gives no issues list, so only status, health and devices were compared/, variant);
  }
});

test("review: Offline to a missing or odd status is not 'back online'", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  state.rooms[0] = { ...state.rooms[0], status: "Offline" };
  await call(c);
  state.rooms[0] = { id: "r1", name: "Room One", health: "Healthy" };
  const r = await call(c);
  assert.doesNotMatch(r.content[0]!.text, /Back online/);
  assert.match(r.content[0]!.text, /Status now reads "unknown" \(was Offline\); not counted as back online/);
});

test("review: room ids like 'constructor' and '__proto__' do not crash or corrupt the snapshot", async () => {
  const { state, client } = fakeAccount();
  state.rooms = [{ id: "constructor", name: "C", status: "Available", health: "Healthy" }, { id: "__proto__", name: "P", status: "Available", health: "Healthy" }];
  const dir = mkdtempSync(join(tmpdir(), "zr-"));
  const store = new FileSnapshotStore(join(dir, "s.json"));
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  const first = await call(c);
  assert.ok(!first.isError, first.content[0]!.text);
  const again = await call(c);
  assert.ok(!again.isError, again.content[0]!.text);
  assert.equal(again.structuredContent.summary, "Nothing changed since the last check (less than a minute ago).");
  assert.deepEqual(Object.keys(store.load()!.rooms).sort(), ["__proto__", "constructor"]);
});

test("review: duplicate room ids are noted and block added/removed claims", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [state.rooms[0], state.rooms[0]];
  const r = await call(c);
  assert.match(r.content[0]!.text, /room id r1 appeared twice/);
  assert.doesNotMatch(r.content[0]!.text, /No longer in the account/);
});

test("review: 'since the last check' is the latest reading; rooms kept from an older check say how old theirs is", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  let t = NOW;
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct", now: () => t });
  await call(c);
  const all = state.rooms;
  state.rooms = [all[1]];
  state.nextToken = "more";
  t = NOW + 3 * DAY;
  await call(c);
  state.rooms = all;
  state.nextToken = "";
  t = NOW + 3 * DAY + 2 * 3_600_000;
  const r = await call(c);
  assert.match(r.structuredContent.summary, /since the last check \(2 hours ago\)/);
  assert.match(r.content[0]!.text, /1 room was compared with an older reading, from 3 days ago/);
});

// From the ship pipeline's Codex review (2026-11-24): an offline device that disappears from Zoom's device list was
// reported "back online", though recovery was never seen.
test("an offline device that is gone from the device list is not 'back online'", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [{ name: "Controller", device_type: "Controller", status: "Online" }];
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.doesNotMatch(text, /Ceiling Mic \(Microphone\): back online/);
  assert.match(text, /\[changed\] Ceiling Mic \(Microphone\): no longer in the room's device list \(was Offline\); not counted as back online\./);
  // Still listed and online now: back online, as before.
  state.devices.r2 = [{ name: "Ceiling Mic", device_type: "Microphone", status: "Offline" }];
  await call(c);
  state.devices.r2 = [{ name: "Ceiling Mic", device_type: "Microphone", status: "Online" }];
  assert.match((await call(c)).content[0]!.text, /\[better\] Ceiling Mic \(Microphone\): back online \(was Offline\)\./);
});

// Sonnet review of 9296d6e: a check saved before device_hostname was read keyed the device "Unnamed device (Type)".
test("a check saved under the old unnamed key does not report the same down device as newly offline", async () => {
  const { state, client } = fakeAccount();
  state.devices = { r2: [{ device_hostname: "Lobby-PC", device_type: "Panel", status: "Offline" }] };
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  const old = store.load()!;
  const d = old.rooms.r2!.detail!;
  d.down = { "Unnamed device (Panel)": "Offline" };
  d.seen = ["Unnamed device (Panel)"];
  store.save(old);
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /was online|no longer in the room's device list/, text);
});

// Codex review of b4974a8 (HIGH): two overlapping what_changed calls; the slow older one must not overwrite the newer save.
test("overlapping what_changed calls run one after the other, so the newest reading is the one saved", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slow = true;
  const realList = client.listRooms.bind(client);
  client.listRooms = async () => {
    const snap = structuredClone(await realList());
    if (slow) {
      slow = false;
      await gate;
    }
    return snap;
  };
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  const first = call(c); // reads Room One Available, then waits
  await new Promise((r) => setTimeout(r, 10));
  state.rooms = [{ id: "r1", name: "Room One", status: "Offline", health: "Critical" }, state.rooms[1]];
  const second = call(c);
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([first, second]);
  assert.equal(store.load()!.rooms.r1!.list.status, "Offline");
});

// Codex review of 8cbfc99 (HIGH): Zoom's documented room profile has no issues list; devices must still be compared.
test("a controller going offline is reported when the room profile has no issues list", async () => {
  const { state, client } = fakeAccount();
  const plain: ZoomRoomsClient = { ...client, getRoom: async (id) => ({ id, basic: { name: id } }) };
  state.rooms = [{ id: "b", name: "Board", status: "Available" }];
  state.devices = { b: [{ device_hostname: "Board-Ctl", device_type: "Controller", status: "Online" }] };
  const store = new MemorySnapshotStore();
  const c = await connect(plain, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.devices = { b: [{ device_hostname: "Board-Ctl", device_type: "Controller", status: "Offline" }] };
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /Board-Ctl \(Controller\): Offline \(was online\)/, text);
});

// Codex review of 8cbfc99 (HIGH): two server processes share one saved check.
test("a check never overwrites a newer one another process saved while it was reading", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  const realList = client.listRooms.bind(client);
  let other: any = null;
  client.listRooms = async () => {
    const out = await realList();
    // Meanwhile another process saves a newer check.
    other = structuredClone(store.load()!);
    other.rooms.r1.list.status = "Offline";
    store.save(other);
    return out;
  };
  state.rooms[0] = { ...state.rooms[0], status: "Available" };
  const r = await call(c);
  assert.match(r.content[0]!.text, /could NOT be saved \(another check was saved while this one was reading Zoom/);
  assert.equal(store.load()!.rooms.r1!.list.status, "Offline");
});
