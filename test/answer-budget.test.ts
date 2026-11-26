import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HttpZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { MemorySnapshotStore, readAccount } from "../src/changes.ts";
import { createServer } from "../src/server.ts";

// Codex review of beaf5dc (11/25): three ways a slow Zoom could push a tool past a default MCP client's 60 s deadline.
// These tests use small budgets so they run in about a second; the shape is the same at 50 s.

type Result = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const connect = async (client: ZoomRoomsClient, answerBudgetMs: number, snapshots = new MemorySnapshotStore(null)) => {
  const server = createServer({ client, source: "zoom", cardHtml: null, snapshots, account: "acct", answerBudgetMs });
  const c = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([c.connect(a), server.connect(b)]);
  return c;
};

/** A fetch that answers the Zoom token at once and each room-list page after `pageMs`, honoring abort. */
const slowPagesFetch = (pageMs: number, pages: number) => {
  let served = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 3600 }));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, pageMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(init.signal!.reason ?? new DOMException("aborted", "AbortError"));
      });
    });
    served++;
    const page = served;
    const rooms = Array.from({ length: 3 }, (_, i) => ({ id: `p${page}-${i}`, name: `Page ${page} room ${i}`, status: "Available", health: "Healthy" }));
    return new Response(JSON.stringify({ rooms, next_page_token: page < pages ? `t${page}` : "" }));
  }) as typeof fetch;
};

test("review: room-list paging stops at the reading's deadline, so a slow multi-page list still answers in time", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = slowPagesFetch(300, 3);
  try {
    const client = new HttpZoomRoomsClient({ accountId: "a-budget", clientId: "c", clientSecret: "s" });
    const t0 = Date.now();
    const reading = await readAccount(client, null, { budgetMs: 500 });
    const took = Date.now() - t0;
    assert.ok(took < 750, `took ${took} ms; paging ignored the deadline`);
    assert.equal(reading.fullList, false, "a list cut short must not read as the whole account");
    assert.ok(reading.rooms.size >= 3 && reading.rooms.size < 9, `read ${reading.rooms.size} rooms`);
    assert.ok(reading.couldNotCheck.some((n) => n.startsWith("Room list: more rooms exist than were read")));
  } finally {
    globalThis.fetch = real;
  }
});

test("review: a fast multi-page list is still read whole under a deadline", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = slowPagesFetch(5, 3);
  try {
    const client = new HttpZoomRoomsClient({ accountId: "a-fast", clientId: "c", clientSecret: "s" });
    const reading = await readAccount(client, null, { budgetMs: 2_000 });
    assert.equal(reading.fullList, true);
    assert.equal(reading.rooms.size, 9);
  } finally {
    globalThis.fetch = real;
  }
});

/** 10 rooms with no health (each needs a detail read); every device read takes `deviceMs`. */
const slowDetails = (deviceMs: number, listMs = 0) => {
  const rooms = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, name: `Slow ${i}`, status: "Offline", health: "Critical" }));
  const client: ZoomRoomsClient = {
    listRooms: async () => {
      await wait(listMs);
      return { rooms, next_page_token: "" };
    },
    getRoom: async (id) => {
      await wait(deviceMs);
      return { id, issues: [] };
    },
    getRoomDevices: async () => {
      await wait(deviceMs);
      return { devices: [{ name: "Controller", device_type: "Controller", status: "Offline" }] };
    },
  };
  return client;
};

test("review: a second simultaneous what_changed answers within its own budget, counting its wait for the first", async () => {
  const c = await connect(slowDetails(250), 600);
  const t0 = Date.now();
  const times: number[] = [];
  const [a, b] = await Promise.all(
    [0, 1].map(() =>
      (c.callTool({ name: "what_changed", arguments: {} }) as Promise<Result>).then((r) => {
        times.push(Date.now() - t0);
        return r;
      }),
    ),
  );
  for (const t of times) assert.ok(t < 700, `a call took ${t} ms against a 600 ms budget`);
  assert.ok(a && b);
});

test("review: a what_changed that ran past its budget answers 'too slow' and saves nothing", async () => {
  const store = new MemorySnapshotStore(null);
  // The list alone takes longer than the whole budget.
  const c = await connect(slowDetails(10, 500), 200, store);
  const t0 = Date.now();
  const r = (await c.callTool({ name: "what_changed", arguments: {} })) as Result;
  assert.ok(Date.now() - t0 < 400, "did not answer within the budget");
  assert.equal(r.isError, true);
  assert.match(r.content[0]!.text, /too slow to answer within/);
  await wait(500);
  assert.equal(store.load(), null, "a cut-off check must not be saved");
});

test("review: diagnose_room on an offline room answers within the budget even when every Zoom read is slow", async () => {
  const c = await connect(slowDetails(300, 300), 500);
  const t0 = Date.now();
  const r = (await c.callTool({ name: "diagnose_room", arguments: { roomId: "s0" } })) as Result;
  const took = Date.now() - t0;
  assert.ok(took < 700, `took ${took} ms against a 500 ms budget`);
  assert.ok(r.content[0]!.text.length > 0);
});

test("review: diagnose_room reads the room profile and its devices at the same time", async () => {
  const c = await connect(slowDetails(300), 5_000);
  const t0 = Date.now();
  const r = (await c.callTool({ name: "diagnose_room", arguments: { roomId: "s0" } })) as Result;
  const took = Date.now() - t0;
  assert.notEqual(r.isError, true, r.content[0]!.text);
  // Serial reads take at least 600 ms (plus the list lookup); parallel ones about 300 ms.
  assert.ok(took < 550, `took ${took} ms; profile and device reads ran one after the other`);
});

test("review: a queued what_changed that was already cut off never reads Zoom, so retries do not pile up", async () => {
  let lists = 0;
  const base = slowDetails(10, 500);
  const client: ZoomRoomsClient = { ...base, listRooms: async () => (lists++, base.listRooms()) };
  const c = await connect(client, 200);
  const rs = (await Promise.all([0, 1, 2].map(() => c.callTool({ name: "what_changed", arguments: {} })))) as Result[];
  for (const r of rs) assert.match(r.content[0]!.text, /too slow to answer within/);
  await wait(700);
  assert.equal(lists, 1, `the room list was read ${lists} times for calls that had already answered`);
});

test("review: the first room-list page and the token never run past the reading's deadline", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = slowPagesFetch(800, 1);
  try {
    const client = new HttpZoomRoomsClient({ accountId: "a-first", clientId: "c", clientSecret: "s" });
    const t0 = Date.now();
    await assert.rejects(readAccount(client, null, { budgetMs: 300 }), /did not answer/);
    assert.ok(Date.now() - t0 < 600, `took ${Date.now() - t0} ms`);
  } finally {
    globalThis.fetch = real;
  }
});
