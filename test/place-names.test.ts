// Readable place names (2026-11-23): a live Zoom account gives rooms only a location_id code; the names live in
// GET /rooms/locations. These run against live-shaped fixtures: room details with no building or floor text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";
import { diagnoseRoom } from "../src/diagnose.ts";
import { roomsNeedingAttention } from "../src/attention.ts";
import { HttpZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { createServer } from "../src/server.ts";

const NOW = Date.parse("2026-03-28T17:00:00Z");
const ok = [{ name: "Zoom Rooms Controller", device_type: "Controller", status: "Online", firmware: "5.17.0" }];

/** A Zoom-shaped location tree: country > states > city > campus > two buildings > floors (two named "2nd Floor"). */
const TREE = [
  { id: "C1", name: "United States", type: "country", parent_location_id: "" },
  { id: "S1", name: "Illinois", type: "states", parent_location_id: "C1" },
  { id: "CI1", name: "Chicago", type: "city", parent_location_id: "S1" },
  { id: "CA1", name: "HQ Campus", type: "campus", parent_location_id: "CI1" },
  { id: "B1", name: "Building 1", type: "building", parent_location_id: "CA1" },
  { id: "B2", name: "Building 2", type: "building", parent_location_id: "CA1" },
  { id: "49D7a0xPQvGQ2DCMZgSe7w", name: "4th Floor", type: "floor", parent_location_id: "B1" },
  { id: "F2a", name: "2nd Floor", type: "floor", parent_location_id: "B1" },
  { id: "F2b", name: "2nd Floor", type: "floor", parent_location_id: "B2" },
];
const F4 = "49D7a0xPQvGQ2DCMZgSe7w";

/** A live-shaped account: list rows carry location_id; details have no location text. */
const account = (rows: any[], opts: { locations?: () => Promise<unknown>; devices?: Record<string, any[]> } = {}) => {
  const calls = { locations: 0 };
  const client: ZoomRoomsClient = {
    listRooms: async () => ({ rooms: rows }),
    getRoom: async (id) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`Zoom API 404 on /rooms/${id}`);
      return { id, name: r.name, issues: [], last_online: r.last_online };
    },
    getRoomDevices: async (id) => ({ devices: opts.devices?.[id] ?? ok }),
    listLocations: async () => {
      calls.locations++;
      return opts.locations ? opts.locations() : { locations: TREE, next_page_token: "" };
    },
  };
  return { client, calls };
};
const offline = (id: string, location_id: string, last_online = "2026-03-28T09:20:00Z") => ({ id, name: id.toUpperCase(), status: "Offline", health: "Critical", location_id, last_online });

test("live-shaped account: offline rooms on one floor are named by place, not by Zoom's location code", async () => {
  const { client, calls } = account([offline("a", F4), offline("b", F4, "2026-03-28T09:24:00Z"), offline("c", F4, "2026-03-28T09:27:00Z")]);
  const d = await diagnoseRooms(client, NOW);
  assert.equal(d.patterns.length, 1);
  assert.equal(d.patterns[0]!.title, "3 room computers offline on Building 1, 4th Floor, last online within 7 min of each other");
  assert.match(d.patterns[0]!.check, /serve Building 1, 4th Floor first/);
  assert.doesNotMatch(d.summary, new RegExp(F4));
  assert.equal(d.placeNote, null);
  assert.equal(calls.locations, 1, "the location list is read once for the whole call");
});

test("two floors with the same name in different buildings stay two places", async () => {
  const { client } = account([offline("a", "F2a"), offline("b", "F2a"), offline("c", "F2b"), offline("d", "F2b")]);
  const d = await diagnoseRooms(client, NOW);
  assert.deepEqual(d.patterns.map((p) => [p.title.replace(/, last online.*/, ""), p.rooms]).sort(), [
    ["2 room computers offline on Building 1, 2nd Floor", ["A", "B"]],
    ["2 room computers offline on Building 2, 2nd Floor", ["C", "D"]],
  ]);
});

test("rooms in one building but on different floors are not grouped as one place", async () => {
  const { client } = account([offline("a", F4), offline("b", "F2a")]);
  const d = await diagnoseRooms(client, NOW);
  assert.deepEqual(d.patterns.filter((p) => p.kind === "location-offline"), []);
});

test("a location list that cannot be read keeps the codes, says why, and is not a could-not-check", async () => {
  const { client } = account([offline("a", F4), offline("b", F4)], { locations: async () => { throw new Error("Zoom API 403 on /rooms/locations: No permission."); } });
  const d = await diagnoseRooms(client, NOW);
  assert.equal(d.patterns[0]!.title.replace(/, last online.*/, ""), `2 room computers offline on ${F4}`);
  assert.match(d.placeNote ?? "", /^Place names: 1 place is shown as its Zoom location code because Zoom's location list could not be read \(Zoom API 403/);
  assert.match(d.summary, /Place names: 1 place is shown/);
  assert.ok(!d.couldNotCheck.some((c) => /location/i.test(c)), "a missing name is not a missed health check");
});

test("a healthy account never reads the location list, and stays a real all-clear", async () => {
  const healthy = [{ id: "a", name: "A", status: "Available", health: "Healthy", location_id: F4 }];
  const { client, calls } = account(healthy, { locations: async () => { throw new Error("should not be called"); } });
  const d = await diagnoseRooms(client, NOW);
  assert.equal(d.allClear, true);
  assert.equal(calls.locations, 0);
  const a = await roomsNeedingAttention(client);
  assert.equal(a.allClear, true);
  assert.equal(a.placeNote, null);
  assert.equal(calls.locations, 0);
});

test("a problem room whose location fails to load is still not an all-clear, and its diagnosis is unchanged", async () => {
  const rows = [offline("a", F4)];
  const named = await diagnoseRoom(account(rows).client, "a", NOW);
  const failed = await diagnoseRoom(account(rows, { locations: async () => { throw new Error("timeout"); } }).client, "a", NOW);
  assert.equal(failed.allClear, false);
  assert.deepEqual(failed.findings, named.findings);
  assert.deepEqual(failed.couldNotCheck, named.couldNotCheck);
  assert.equal(named.room!.where, "Building 1, 4th Floor");
  assert.equal(failed.room!.where, F4);
  assert.equal(failed.room!.placeKey, named.room!.placeKey, "grouping key does not depend on the name lookup");
});

test("get_rooms_needing_attention names the place for a live-shaped problem room", async () => {
  const { client, calls } = account([offline("a", F4), { id: "b", name: "B", status: "Available", health: "Warning", location_id: "F2b" }]);
  const a = await roomsNeedingAttention(client);
  assert.deepEqual(a.rooms.map((r) => r.where), ["Building 1, 4th Floor", "Building 2, 2nd Floor"]);
  assert.match(a.summary, /A \(Building 1, 4th Floor\): Offline/);
  assert.equal(calls.locations, 1);
});

test("a code missing from the location list stays a code and the reply says so", async () => {
  const { client } = account([offline("a", "GONE123")]);
  const a = await roomsNeedingAttention(client);
  assert.equal(a.rooms[0]!.where, "GONE123");
  assert.match(a.placeNote ?? "", /1 place is shown as its Zoom location code because Zoom's location list does not include it/);
});

test("a location list cut short by paging says the missing name may be on a page not read", async () => {
  const { client } = account([offline("a", "LATER")], { locations: async () => ({ locations: TREE, next_page_token: "more" }) });
  const a = await roomsNeedingAttention(client);
  assert.equal(a.placeNote, "Place names: 1 place is shown as its Zoom location code; Zoom has more pages of locations than were read, so it may be on a page not read. Grouping by place is not affected.");
});

test("region levels are dropped; a floor right under a city still gets a name; a parent loop stops", async () => {
  const odd = [
    { id: "C1", name: "United States", type: "country", parent_location_id: "" },
    { id: "CI1", name: "Austin", type: "city", parent_location_id: "C1" },
    { id: "FX", name: "Ground Floor", type: "floor", parent_location_id: "CI1" },
    { id: "L1", name: "Loop A", type: "building", parent_location_id: "L2" },
    { id: "L2", name: "Loop B", type: "campus", parent_location_id: "L1" },
    { id: "R1", name: "Texas", type: "states", parent_location_id: "C1" },
  ];
  const { client } = account([offline("a", "FX"), offline("b", "L1"), offline("c", "R1")], { locations: async () => ({ locations: odd }) });
  const a = await roomsNeedingAttention(client);
  assert.deepEqual(a.rooms.map((r) => r.where).sort(), ["Ground Floor", "Loop B, Loop A", "United States, Texas"]);
});

test("demo campus: room names and wording are unchanged where Zoom gives building and floor text", async () => {
  const { DemoZoomRoomsClient } = await import("../src/client.ts");
  const a = await roomsNeedingAttention(new DemoZoomRoomsClient());
  assert.deepEqual(a.rooms.map((r) => r.where), ["Building 1, 4th Floor", "Building 1, 2nd Floor", "Building 1, 2nd Floor"]);
  assert.equal(a.placeNote, null);
});

test("diagnose_room over MCP prints the place name and, when it fails, the reason", async () => {
  const connect = async (client: ZoomRoomsClient) => {
    const server = createServer({ client, source: "zoom", cardHtml: null, account: "acct" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "t", version: "1" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return mcp;
  };
  const good = await connect(account([offline("a", F4)]).client);
  const r1: any = await good.callTool({ name: "diagnose_room", arguments: { roomId: "a" } });
  assert.match(r1.content[0].text, /^A \(Building 1, 4th Floor\)/);
  const bad = await connect(account([offline("a", F4)], { locations: async () => { throw new Error("Zoom API 403"); } }).client);
  const r2: any = await bad.callTool({ name: "diagnose_room", arguments: { roomId: "a" } });
  assert.match(r2.content[0].text, /\n\nPlace names: 1 place is shown as its Zoom location code because Zoom's location list could not be read \(Zoom API 403\)/);
  assert.equal(r2.structuredContent.placeNote.startsWith("Place names:"), true);
});

/** Serve GET /rooms/locations as pages: pages[n] answers the request after token `t${n}`. */
const serve = (t: any, pages: (() => Response)[]) => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth/token")) return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    seen.push(url.pathname + url.search);
    const token = url.searchParams.get("next_page_token");
    return pages[token ? Number(token.slice(1)) : 0]!();
  }) as typeof fetch;
  return seen;
};
const page = (rows: any[], next = "") => () => new Response(JSON.stringify({ page_size: 300, next_page_token: next, locations: rows }), { status: 200 });
let n = 0;
const creds = () => ({ accountId: `loc-${++n}`, clientId: "c", clientSecret: "s" });

test("HTTP: reads every page of locations at Zoom's max page size", async (t) => {
  const seen = serve(t, [page(TREE.slice(0, 5), "t1"), page(TREE.slice(5))]);
  const got = (await new HttpZoomRoomsClient(creds()).listLocations()) as any;
  assert.equal(got.locations.length, TREE.length);
  assert.equal(got.next_page_token, "");
  assert.deepEqual(seen, ["/v2/rooms/locations?page_size=300", "/v2/rooms/locations?page_size=300&next_page_token=t1"]);
});

test("HTTP: a repeated page token or an odd page stops with an honest error", async (t) => {
  serve(t, [page(TREE, "t1"), page(TREE, "t1")]);
  await assert.rejects(new HttpZoomRoomsClient(creds()).listLocations(), /repeated a page token on page 2 of the location list/);
});
