import { mock, test } from "node:test";
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

// Codex review of bc4f318 (HIGH): a profile without issues must not erase the last known open issue.
test("an open issue survives a check whose profile has no issues list, and its closure is reported later", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c); // Room Two: "Microphone offline" open
  const plain: ZoomRoomsClient = { ...client, getRoom: async (id) => ({ id }) };
  await call(await connect(plain, { snapshots: store, source: "zoom", account: "acct" }));
  assert.deepEqual(store.load()!.rooms.r2!.detail!.issues, ["Microphone offline"]);
  const kept = store.load()!.rooms.r2!.detail!;
  assert.ok(kept.issuesAt && kept.issuesAt <= kept.at, JSON.stringify(kept));
  state.issues = { r2: [] };
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /Issue closed: Microphone offline/, text);
});

test("the file store's save lock: a fresh lock blocks, a stale one is taken over", async () => {
  const { mkdtempSync, writeFileSync: write, utimesSync, existsSync: exists } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/zoom-lock-`);
  const store = new FileSnapshotStore(`${dir}/state.json`);
  write(`${dir}/state.json.lock`, "");
  assert.throws(() => store.exclusive(() => 1), /another check is being saved right now/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${dir}/state.json.lock`, old, old);
  assert.equal(store.exclusive(() => 2), 2);
  assert.equal(exists(`${dir}/state.json.lock`), false);
});

test("review: a lock is removed only by its holder, and a stale one is taken over by rename", async () => {
  const { mkdtempSync, writeFileSync: write, utimesSync, readFileSync: read, existsSync: exists } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/zoom-lock2-`);
  const store = new FileSnapshotStore(`${dir}/state.json`);
  // Inside the first holder's run, another process takes the lock over (as if this save ran past the stale age).
  store.exclusive(() => write(`${dir}/state.json.lock`, "someone-else"));
  assert.equal(read(`${dir}/state.json.lock`, "utf8"), "someone-else");
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${dir}/state.json.lock`, old, old);
  assert.equal(store.exclusive(() => 3), 3);
  assert.equal(exists(`${dir}/state.json.lock`), false);
});

// ---- Codex review 11/25 (HIGH): 25 rooms with slow device reads must still answer inside the 60 s MCP deadline ----
const slowAccount = (n: number, deviceMs: number) => {
  // Zoom omits health, so every room needs a detail read.
  const rooms = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: `Slow ${i}`, status: "Available" }));
  const client: ZoomRoomsClient = {
    listRooms: async () => ({ rooms, next_page_token: "" }),
    getRoom: async (id) => ({ id, issues: [] }),
    getRoomDevices: () => new Promise((resolve) => setTimeout(() => resolve({ devices: [{ name: "Controller", device_type: "Controller", status: "Offline" }] }), deviceMs)),
  };
  return client;
};

test("review: 25 rooms whose device reads take 3 s each are all read well inside 60 s", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  try {
    let done: Awaited<ReturnType<typeof readAccount>> | undefined;
    const p = readAccount(slowAccount(25, 3_000), null).then((r) => (done = r));
    for (let s = 0; s < 60 && !done; s++) {
      mock.timers.tick(1_000);
      for (let k = 0; k < 20; k++) await Promise.resolve();
    }
    assert.ok(done, "what_changed's reading did not finish within 60 s");
    await p;
    assert.equal(done!.details.size, 25);
    assert.ok(Date.now() - NOW <= 20_000, `took ${(Date.now() - NOW) / 1000} s`);
  } finally {
    mock.timers.reset();
  }
});

test("review: when Zoom is too slow for the time budget, the check answers in time, names unread rooms and keeps their last reading", async () => {
  // First check: every room read, each with an offline controller.
  const fast = slowAccount(25, 0);
  const first = await readAccount(fast, null);
  const snap = nextSnapshot(first, null, "acct", NOW - DAY);
  assert.equal(Object.values(snap.rooms).filter((r) => r.detail).length, 25);
  // Second check: device reads take 100 ms, budget 250 ms, 5 at a time -> only some rooms read.
  const t0 = Date.now();
  const reading = await readAccount(slowAccount(25, 100), snap, { budgetMs: 250, concurrency: 5 });
  const took = Date.now() - t0;
  assert.ok(took < 1_000, `took ${took} ms; reads were not bounded`);
  assert.ok(reading.details.size > 0 && reading.details.size < 25, `read ${reading.details.size}`);
  const unread = [...reading.rooms.keys()].filter((id) => !reading.details.has(id));
  const out = compare(reading, snap, NOW);
  for (const id of unread) assert.ok(out.notCompared.some((n) => n.startsWith(`${reading.rooms.get(id)!.name}: issues and devices not read; Zoom was slow`)), id);
  const next = nextSnapshot(reading, snap, "acct", NOW);
  for (const id of unread) assert.deepEqual(next.rooms[id]!.detail, snap.rooms[id]!.detail, `${id} lost its last reading`);
});

// Codex review of b4974a8 (MEDIUMs, 11/25).
test("review: an issue whose status turns resolved reads as closed", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  state.issues.r2 = [{ issue: "Camera disconnected", status: "open" }];
  await call(c);
  state.issues.r2 = [{ issue: "Camera disconnected", status: "resolved" }];
  const r = await call(c);
  assert.match(r.content[0]!.text, /Issue closed: Camera disconnected\./);
});

test("review: two rooms with one name that both go offline are two changed rooms, each with its id", async () => {
  const { state, client } = fakeAccount();
  state.rooms = [
    { id: "l1", name: "Lobby", status: "Available", health: "Healthy" },
    { id: "l2", name: "Lobby", status: "Available", health: "Healthy" },
  ];
  state.issues = {};
  state.devices = {};
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = state.rooms.map((r) => ({ ...r, status: "Offline" }));
  const r = await call(c);
  assert.match(r.structuredContent.summary, /^2 rooms changed, 2 for the worse/);
  assert.match(r.content[0]!.text, /Lobby \(Zoom room l1\):\n- \[worse\] Went offline/);
  assert.match(r.content[0]!.text, /Lobby \(Zoom room l2\):\n- \[worse\] Went offline/);
});

test("review: a first check that could not read a room's devices says so in its text", async () => {
  const { state, client } = fakeAccount();
  state.failDetail.add("r2");
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  const r = await call(c);
  assert.match(r.content[0]!.text, /Not read in this first check:\n- Room Two: issues and devices could not be read/);
});

test("review: a first check on a partial list words its notes for a first check", async () => {
  const { state, client } = fakeAccount();
  state.nextToken = "more";
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /- Room list: more rooms exist than were read\n/);
  assert.doesNotMatch(text, /added or removed|not compared/);
});

// Codex review of cdd6d8e / b4974a8 (MEDIUM, changes.ts:153): two controllers with one name collapsed into one entry.
const panel = (id: string | undefined, status: string) => ({ ...(id ? { id } : {}), device_hostname: "Panel", device_type: "Controller", status });
test("review: two same-named controllers are told apart by Zoom device id; one dropping while the other recovers is reported", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Offline"), panel("p2", "Online")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Offline")];
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /\[worse\] Panel \(Controller, Zoom device p2\): Offline \(was online\)\./, text);
  assert.match(text, /\[better\] Panel \(Controller, Zoom device p1\): back online \(was Offline\)\./, text);
});

test("review: a check saved before device ids were kept is not misread when a name now covers two devices", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Offline")];
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  assert.deepEqual(store.load()!.rooms.r2!.detail!.down, { "Panel (Controller)": "Offline" });
  state.devices.r2 = [panel("p1", "Offline"), panel("p2", "Online")];
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.doesNotMatch(text, /was online|no longer in the room's device list|back online/, text);
  assert.match(text, /Panel \(Controller\) could not be matched to this check's devices with that name/, text);
  // The next check compares them one by one.
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Offline")];
  const next = (await call(c)).content[0]!.text;
  assert.match(next, /Zoom device p2\): Offline \(was online\)/, next);
  assert.match(next, /Zoom device p1\): back online/, next);
});

test("review: a down device keeps its history when a second device with its name arrives, and when it leaves", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Offline"), panel("p2", "Online")];
  const joined = (await call(c)).content[0]!.text;
  assert.doesNotMatch(joined, /was online|no longer in the room's device list|back online/, joined);
  state.devices.r2 = [panel("p1", "Offline")];
  const left = (await call(c)).content[0]!.text;
  assert.doesNotMatch(left, /was online|no longer in the room's device list|back online/, left);
  state.devices.r2 = [panel("p1", "Online")];
  assert.match((await call(c)).content[0]!.text, /\[better\] Panel \(Controller\): back online \(was Offline\)\./);
});

test("review: same-named devices with no Zoom id are compared as one and say so", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Online"), panel(undefined, "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /more than one Panel \(Controller\) and Zoom gave no device id to tell them apart, so they were (compared|read) as one/, text);
});

// Sonnet review of 65b2000.
test("review: a second same-named device that arrives down is reported, even when the old check predates ids", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Online")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Offline")];
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /\[worse\] Panel \(Controller, Zoom device p2\): Offline \(at the last check this name read as one device, online/, text);
});

test("review: a down device under an old key, now two online same-named devices, is not called back online", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Online")];
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /\[changed\] Panel \(Controller\): was Offline; Zoom now lists more than one device with this name, all online \(it may have been replaced, so not counted as back online\)/, text);
  assert.doesNotMatch(text, /back online \(/);
});

test("review: a duplicate that gains a Zoom id keeps its history", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Online"), panel(undefined, "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Offline")];
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /was online|no longer in the room's device list|back online/, text);
});

test("review: the shared-name note is said once, not on every check", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Online"), panel(undefined, "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  assert.match((await call(c)).content[0]!.text, /as one/);
  assert.doesNotMatch((await call(c)).content[0]!.text, /as one/);
});

// Codex review of cdd6d8e / b4974a8 (MEDIUM, changes.ts:186): deleting the last room was never reported.
test("review: deleting the last rooms is reported once a second clean read in a row also finds none", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  let t = NOW;
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct", now: () => t });
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
  await call(c);
  state.rooms = [];
  const first = (await call(c)).content[0]!.text;
  assert.doesNotMatch(first, /No longer in the account/);
  assert.match(first, /If a saved check 10 minutes to a week after the first saved empty one also finds none, the rooms are reported removed/);
  // An immediate re-run does not confirm (Sonnet review, 11/27), and does not restart the wait.
  t += 5 * 60_000;
  mock.timers.setTime(t);
  assert.doesNotMatch((await call(c)).content[0]!.text, /No longer in the account/);
  assert.equal(store.load()!.emptyListAt, new Date(NOW).toISOString());
  t += 6 * 60_000;
  mock.timers.setTime(t);
  const second = (await call(c)).content[0]!.text;
  assert.match(second, /Room One:\n- \[changed\] No longer in the account's room list/, second);
  assert.match(second, /Room Two:\n- \[changed\] No longer in the account's room list/, second);
  assert.equal(Object.keys(store.load()!.rooms).length, 0);
  assert.equal(store.load()!.emptyListAt, undefined);
  assert.match((await call(c)).content[0]!.text, /^Nothing changed/);
  } finally {
    mock.timers.reset();
  }
});

test("review: a held empty read older than a week does not confirm; the wait starts again", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [];
  await call(c);
  const s = store.load()!;
  const old = new Date(Date.now() - 9 * DAY).toISOString();
  s.emptyListAt = old;
  store.save(s);
  assert.doesNotMatch((await call(c)).content[0]!.text, /No longer in the account/);
  assert.notEqual(store.load()!.emptyListAt, old);
});

test("review: an empty read between two full ones does not confirm a later empty read", async () => {
  const { state, client } = fakeAccount();
  const rooms = state.rooms;
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [];
  await call(c);
  state.rooms = rooms;
  await call(c);
  assert.equal(store.load()!.emptyListAt, undefined);
  state.rooms = [];
  assert.doesNotMatch((await call(c)).content[0]!.text, /No longer in the account/);
});

test("review: an empty page that still has a next-page token never confirms a deletion", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [];
  state.nextToken = "more";
  await call(c);
  assert.doesNotMatch((await call(c)).content[0]!.text, /No longer in the account/);
});

// Codex review of af2032a.
const twoEmptyReads = async (listRooms: ZoomRoomsClient["listRooms"]) => {
  const { state, client } = fakeAccount();
  let t = NOW;
  const c = await connect({ ...client, listRooms: async (o) => (state.rooms.length ? client.listRooms(o) : listRooms(o)) }, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct", now: () => t });
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    await call(c);
    state.rooms = [];
    await call(c);
    t += 11 * 60_000;
    mock.timers.setTime(t);
    return (await call(c)).content[0]!.text;
  } finally {
    mock.timers.reset();
  }
};
test("review: an empty page that still counts rooms (total_records) never confirms a deletion", async () => {
  assert.doesNotMatch(await twoEmptyReads(async () => ({ rooms: [], total_records: 2, next_page_token: "" })), /No longer in the account/);
});
test("review: two empty pages with a next-page token 11 minutes apart never confirm a deletion", async () => {
  assert.doesNotMatch(await twoEmptyReads(async () => ({ rooms: [], next_page_token: "more" })), /No longer in the account/);
});
test("review: the same two empty reads with no count and no token do confirm it", async () => {
  assert.match(await twoEmptyReads(async () => ({ rooms: [], next_page_token: "" })), /No longer in the account/);
});

test("review: a device the last check never listed that first shows Offline is new, not 'was online'", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [...state.devices.r2!, { name: "Rear Camera", device_type: "Camera", status: "Offline" }];
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /\[worse\] Rear Camera \(Camera\): Offline \(new in the room's device list since the last check\)\./, text);
  assert.doesNotMatch(text, /Rear Camera.*was online/);
});

test("review: an Offline room behind 25 Warning rooms is still read in detail", async () => {
  const { state, client } = fakeAccount();
  const read: string[] = [];
  const spy: ZoomRoomsClient = { ...client, getRoomDevices: async (id) => (read.push(id), client.getRoomDevices(id)) };
  state.rooms = [...Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, name: `Warn ${i}`, status: "Available", health: "Warning" })), { id: "off", name: "Down Room", status: "Offline", health: "Critical" }];
  const reading = await readAccount(spy, null);
  assert.ok(read.includes("off"), "the Offline room was read");
  assert.ok(reading.skippedDetail.includes("Warn 24") || reading.skippedDetail.length === 1);
  assert.ok(!reading.skippedDetail.includes("Down Room"));
});

// Codex review of af2032a: device matching.
test("review: two devices that swap names keep their own histories by Zoom device id", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [{ id: "a", name: "Panel", device_type: "Controller", status: "Offline" }, { id: "b", name: "Backup", device_type: "Controller", status: "Online" }];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [{ id: "a", name: "Backup", device_type: "Controller", status: "Offline" }, { id: "b", name: "Panel", device_type: "Controller", status: "Online" }];
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.ok(!r.isError, text);
  assert.doesNotMatch(text, /back online|was online|no longer in the room's device list|Controller\)/, text);
  assert.match(text, /^(Nothing changed|No changes in what could be compared)/, text);
});

test("review: id-less same-named devices listed in another order are not a status change", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel(undefined, "Offline"), panel(undefined, "Disconnected")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel(undefined, "Disconnected"), panel(undefined, "Offline")];
  assert.doesNotMatch((await call(c)).content[0]!.text, /Panel \(Controller\): now/);
});

test("review: an id-less down Panel removed while a new p2 joins p1 is not called recovered", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Online"), panel(undefined, "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Online")];
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /back online|was online/, text);
  assert.match(text, /could not be matched/, text);
});

test("review: a first detailed reading that groups id-less devices says so", async () => {
  const { state, client } = fakeAccount();
  state.devices.r1 = [{ name: "Controller", device_type: "Controller", status: "Online" }];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms[0] = { ...state.rooms[0], status: "Offline" };
  state.devices.r1 = [panel(undefined, "Offline"), panel(undefined, "Offline")];
  assert.match((await call(c)).content[0]!.text, /Room One: more than one Panel \(Controller\) and Zoom gave no device id/);
});

// Sonnet review of a95979d.
test("review: an online id-less twin replaced by a new id'd device that is down is reported", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Online"), panel(undefined, "Online")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p1", "Online"), panel("p2", "Offline")];
  assert.match((await call(c)).content[0]!.text, /\[worse\] Panel \(Controller, Zoom device p2\): Offline \(at the last check/);
});

test("review: a down device that leaves while another takes its name is reported as no longer listed", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [{ id: "a", name: "A", device_type: "Controller", status: "Offline" }, { id: "b", name: "B", device_type: "Controller", status: "Offline" }];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [{ id: "a", name: "B", device_type: "Controller", status: "Offline" }];
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /B \(Controller\) \(Zoom device b\): no longer in the room's device list \(was Offline\)/, text);
  assert.doesNotMatch(text, /\[better\]|was online/, text);
});

// Codex review of 76d775b.
test("review: a last page with no token that counts more rooms than it returned never reports removals", async () => {
  const { state, client } = fakeAccount();
  const c = await connect({ ...client, listRooms: async (o) => ({ ...((await client.listRooms(o)) as object), total_records: 2 }) }, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [state.rooms[0]];
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /No longer in the account/, text);
  assert.match(text, /Zoom counts 2 rooms but returned 1/, text);
});

test("review: an offline controller replaced by an online one with the same name (new Zoom id) is not back online", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("a", "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("b", "Online")];
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /\[better\]/, text);
  assert.match(text, /Panel \(Controller\) \(Zoom device a\): no longer in the room's device list \(was Offline\)/, text);
  // And a down replacement is new, not "was online" or "now Offline (was Offline)".
  state.devices.r2 = [panel("c", "Offline")];
  const next = (await call(c)).content[0]!.text;
  assert.match(next, /\[worse\] Panel \(Controller\): Offline \(new in the room's device list since the last check\)/, next);
});

test("review: saved ids settle an offline p1 replaced by online p2 and p3", async () => {
  const { state, client } = fakeAccount();
  state.devices.r2 = [panel("p1", "Offline")];
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.devices.r2 = [panel("p2", "Online"), panel("p3", "Online")];
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /could not be matched|\[better\]|may have been replaced/, text);
  assert.match(text, /\(Zoom device p1\): no longer in the room's device list \(was Offline\)/, text);
});

test("review: a new offline room with id-less twins names the grouping", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [...state.rooms, { id: "r3", name: "Room Three", status: "Offline", health: "Critical" }];
  state.devices.r3 = [panel(undefined, "Offline"), panel(undefined, "Offline")];
  assert.match((await call(c)).content[0]!.text, /Room Three: more than one Panel \(Controller\) and Zoom gave no device id/);
});

// Sonnet review of 0d2d8bf.
test("review: a down device whose Zoom id changes between reads stays one device still down", async () => {
  const { state, client } = fakeAccount();
  let n = 0;
  state.devices.r2 = [];
  const churn: ZoomRoomsClient = { ...client, getRoomDevices: async () => ({ devices: [{ id: `x${n++}`, name: "Mic", device_type: "Microphone", status: "Offline" }] }) };
  const c = await connect(churn, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.ok(!r.isError, text);
  assert.match(text, /^(Nothing changed|No changes in what could be compared)/, text);
  assert.doesNotMatch(text, /Mic \(Microphone\)/, text);
});

// Codex review of 436202c.
test("review: a room count in an odd shape is ignored, never a crash", async () => {
  const { client } = fakeAccount();
  const odd = { ...client, listRooms: async (o: any) => ({ ...((await client.listRooms(o)) as object), total_records: { toString: null, valueOf: null } }) } as ZoomRoomsClient;
  const c = await connect(odd, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  const r = await call(c);
  assert.ok(!r.isError, r.content[0]!.text);
});

test("review: a new room seen in a partial list blames this check's list when the last one was whole", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [state.rooms[0], { id: "r9", name: "Room Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /Room Nine: not in the last check's room list, and this check's list was not read in full/, text);
});

// Codex review of efdce73: a room first seen in a partial list is still reported added by the next full read.
test("review: a room first seen in a partial list after a full one is reported new at the next full read", async () => {
  const { state, client } = fakeAccount();
  const store = new MemorySnapshotStore();
  const c = await connect(client, { snapshots: store, source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [...state.rooms, { id: "r9", name: "Room Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  await call(c);
  await call(c);
  state.nextToken = "";
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /Room Nine:\n- \[changed\] New room in the account \(Available, Healthy\)\./, text);
  assert.equal(store.load()!.rooms.r9!.list.unconfirmed, undefined);
  assert.doesNotMatch((await call(c)).content[0]!.text, /Room Nine/);
});

// Sonnet review of d6a561c.
test("review: an unconfirmed room missing from the next full list is not called removed", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  const rooms = state.rooms;
  state.rooms = [...rooms, { id: "r9", name: "Room Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  await call(c);
  state.rooms = rooms;
  state.nextToken = "";
  const text = (await call(c)).content[0]!.text;
  assert.doesNotMatch(text, /No longer in the account/, text);
  assert.match(text, /Room Nine: seen only in an earlier partial room list/, text);
});

test("review: an unconfirmed room that also changed gets one 'New room' line", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [...state.rooms, { id: "r9", name: "Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  await call(c);
  state.rooms[2] = { id: "r9", name: "Room Nine", status: "Offline", health: "Critical" };
  state.nextToken = "";
  const text = (await call(c)).content[0]!.text;
  assert.match(text, /Room Nine:\n- \[worse\] New room in the account \(Offline, Critical\)\.\n\n/, text);
  assert.doesNotMatch(text, /Went offline|Renamed from|Health worse/, text);
});

// Codex review of 2942407.
test("review: a room seen only in a first, partial check is not called removed by the first full one", async () => {
  const { state, client } = fakeAccount();
  const rooms = state.rooms;
  state.rooms = [...rooms, { id: "r9", name: "Room Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = rooms;
  state.nextToken = "";
  const r = await call(c);
  const text = r.content[0]!.text;
  assert.ok(!r.isError, text);
  assert.doesNotMatch(text, /No longer in the account/, text);
  assert.match(text, /Room Nine: seen only in an earlier partial room list and not in this full one/, text);
});

test("review: the full read that confirms a new room still names its grouped devices", async () => {
  const { state, client } = fakeAccount();
  const c = await connect(client, { snapshots: new MemorySnapshotStore(), source: "zoom", account: "acct" });
  await call(c);
  state.rooms = [...state.rooms, { id: "r9", name: "Room Nine", status: "Available", health: "Healthy" }];
  state.nextToken = "more";
  await call(c);
  state.rooms[2] = { ...state.rooms[2], status: "Offline" };
  state.devices.r9 = [panel(undefined, "Offline"), panel(undefined, "Offline")];
  state.nextToken = "";
  assert.match((await call(c)).content[0]!.text, /Room Nine: more than one Panel \(Controller\)/);
});
