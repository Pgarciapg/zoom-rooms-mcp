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
