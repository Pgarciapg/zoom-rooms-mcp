import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpZoomRoomsClient, MAX_ROOM_PAGES, ROOM_PAGE_SIZE } from "../src/client.ts";
import { roomsNeedingAttention } from "../src/attention.ts";
import { diagnoseRooms } from "../src/diagnose-rooms.ts";

/** Serve the room list as pages: pages[n] answers the request after token `t${n}`. */
const serve = (t: any, pages: ((url: URL) => Response)[]) => {
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
    const n = token ? Number(token.slice(1)) : 0;
    return pages[n]!(url);
  }) as typeof fetch;
  return seen;
};
const page = (ids: string[], next = "") => () => new Response(JSON.stringify({ page_size: ROOM_PAGE_SIZE, total_records: 5, next_page_token: next, rooms: ids.map((id) => ({ id, name: id, status: "Available", health: "Healthy" })) }), { status: 200 });
let n = 0;
const creds = () => ({ accountId: `pages-${++n}`, clientId: "c", clientSecret: "s" });

test("reads every page of rooms, in order, at Zoom's max page size", async (t) => {
  const seen = serve(t, [page(["a", "b"], "t1"), page(["c", "d"], "t2"), page(["e"])]);
  const list = (await new HttpZoomRoomsClient(creds()).listRooms()) as any;
  assert.deepEqual(list.rooms.map((r: any) => r.id), ["a", "b", "c", "d", "e"]);
  assert.equal(list.next_page_token, "");
  assert.equal(list.page_count, 3);
  assert.deepEqual(seen, ["/v2/rooms?page_size=300", "/v2/rooms?page_size=300&next_page_token=t1", "/v2/rooms?page_size=300&next_page_token=t2"]);
});

test("a page that fails fails the whole list: never a silent partial list", async (t) => {
  serve(t, [page(["a"], "t1"), () => new Response('{"code":124,"message":"Invalid access token."}', { status: 401 })]);
  await assert.rejects(new HttpZoomRoomsClient(creds()).listRooms(), /Zoom API 401 on \/rooms\?page_size=300&next_page_token=t1/);
});

test("a page in an odd shape or a repeated token stops with an honest error", async (t) => {
  serve(t, [page(["a"], "t1"), () => new Response(JSON.stringify({ rooms: { id: "x" } }), { status: 200 })]);
  await assert.rejects(new HttpZoomRoomsClient(creds()).listRooms(), /page 2 of the room list in an unexpected shape/);
});

test("a repeated page token stops instead of looping or double counting", async (t) => {
  serve(t, [page(["a"], "t1"), page(["b"], "t1")]);
  await assert.rejects(new HttpZoomRoomsClient(creds()).listRooms(), /repeated a page token on page 2/);
});

test("the page cap keeps Zoom's token, and both fleet tools then refuse the all-clear", async (t) => {
  const pages = Array.from({ length: MAX_ROOM_PAGES + 1 }, (_, i) => page([`r${i}`], `t${i + 1}`));
  serve(t, pages);
  const client = new HttpZoomRoomsClient(creds());
  const list = (await client.listRooms()) as any;
  assert.equal(list.rooms.length, MAX_ROOM_PAGES);
  assert.equal(list.next_page_token, `t${MAX_ROOM_PAGES}`);
  const attention = await roomsNeedingAttention(client);
  assert.equal(attention.allClear, false);
  assert.ok(attention.couldNotCheck.includes("Room list: Zoom has more pages of rooms than were read."));
  const fleet = await diagnoseRooms(client);
  assert.equal(fleet.allClear, false);
  assert.ok(fleet.couldNotCheck.includes("Room list: Zoom has more pages of rooms than were read."));
});

test("a room on page 2 that is offline is seen by the attention tool", async (t) => {
  serve(t, [page(["a"], "t1"), () => new Response(JSON.stringify({ next_page_token: "", rooms: [{ id: "z", name: "Z", status: "Offline", health: "Critical" }] }), { status: 200 }), () => new Response("{}", { status: 404 })]);
  const client = new HttpZoomRoomsClient(creds());
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: any) => {
    const url = String(input);
    if (/\/rooms\/z(\/devices)?$/.test(url)) return new Response(url.endsWith("devices") ? '{"devices":[]}' : '{"id":"z","name":"Z","issues":[]}', { status: 200 });
    return real(input, init);
  }) as typeof fetch;
  const a = await roomsNeedingAttention(client);
  assert.equal(a.total, 2);
  assert.deepEqual(a.rooms.map((r) => r.name), ["Z"]);
});

// BLOCKS SHIP from the 11/24 9:25 PM Codex review: a room's activation code must never reach a tool result.
test("activation codes are dropped from every page of the room list", async (t) => {
  const withCode = (ids: string[], next = "") => () => new Response(JSON.stringify({ next_page_token: next, rooms: ids.map((id) => ({ id, name: id, status: "Available", activation_code: "SECRET-123" })) }), { status: 200 });
  serve(t, [withCode(["a"], "t1"), withCode(["b"])]);
  const list = (await new HttpZoomRoomsClient(creds()).listRooms()) as any;
  assert.deepEqual(list.rooms.map((r: any) => r.id), ["a", "b"]);
  assert.doesNotMatch(JSON.stringify(list), /activation_code|SECRET-123/);
});

test("a room profile's activation code is dropped too", async (t) => {
  serve(t, [() => new Response(JSON.stringify({ id: "a", activation_code: "SECRET-1", basic: { name: "A", activation_code: "SECRET-2" } }), { status: 200 })]);
  const room = await new HttpZoomRoomsClient(creds()).getRoom("a");
  assert.doesNotMatch(JSON.stringify(room), /SECRET/);
});
