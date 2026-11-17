// MCP App card for get_rooms_needing_attention (2026-11-17). The card mirrors the tool result, loads nothing from the
// network, and is additive: hosts without MCP Apps get the same text and JSON as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { DemoZoomRoomsClient, type ZoomRoomsClient } from "../src/client.ts";
import { CARD_HTML } from "../src/generated/card.ts";
import { createServer, type ServerOptions } from "../src/server.ts";
import { CARD_URI } from "../src/version.ts";

const connect = async (options: ServerOptions) => {
  const client = new Client({ name: "card-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), createServer(options).connect(b)]);
  return client;
};
const attention = async (options: ServerOptions) => (await (await connect(options)).callTool({ name: "get_rooms_needing_attention", arguments: {} })) as any;

test("card: mirrors the result exactly (order, levels, next steps, meeting flag) on the demo campus", async () => {
  const r = await attention({ client: new DemoZoomRoomsClient(), source: "demo" });
  const card = r._meta.card;
  const sc = r.structuredContent;
  assert.equal(card.kind, "attention");
  assert.equal(card.source, "demo");
  assert.equal(card.headline, r.content[0].text.split("\n")[0]);
  assert.deepEqual(card.rooms, sc.rooms);
  assert.deepEqual(card.counts, sc.counts);
  assert.equal(card.total, 32);
  assert.equal(card.allClear, false);
  assert.deepEqual(card.notReadInDetail, []);
});

test("card: nothing wrong but something unread is not an all-clear, and rooms past the limit are named", async () => {
  const rooms = Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, name: `Room ${i}`, status: "Available", health: "Warning" }));
  const client: ZoomRoomsClient = { listRooms: async () => ({ rooms: [...rooms, { id: "x", name: "Lab", status: "Available", health: "" }] }), getRoom: async (id) => ({ id, issues: [] }), getRoomDevices: async () => ({ devices: [] }) };
  const card = (await attention({ client, source: "zoom" }))._meta.card;
  assert.equal(card.rooms.length, 15);
  assert.deepEqual(card.notReadInDetail, ["Room 15", "Room 16"]);
  assert.equal(card.allClear, false);
  assert.ok(card.couldNotCheck.some((c: string) => c.startsWith("Lab:")));

  const unread: ZoomRoomsClient = { listRooms: async () => ({ rooms: [{ id: "x", name: "Lab", status: "Available", health: "Unknown" }] }), getRoom: async () => ({}), getRoomDevices: async () => ({ devices: [] }) };
  const grey = (await attention({ client: unread, source: "zoom" }))._meta.card;
  assert.equal(grey.allClear, false);
  assert.equal(grey.needAttention, 0);
  assert.match(grey.headline, /not an all-clear/);
});

test("card: additive only - same content and structuredContent with or without the card; the tool links the card", async () => {
  const withCard = await attention({ client: new DemoZoomRoomsClient(), source: "demo" });
  const without = await attention({ client: new DemoZoomRoomsClient(), source: "demo", cardHtml: null });
  assert.deepEqual(withCard.content, without.content);
  assert.deepEqual(withCard.structuredContent, without.structuredContent);

  const a = await connect({ client: new DemoZoomRoomsClient(), source: "demo" });
  const tool = (await a.listTools()).tools.find((t) => t.name === "get_rooms_needing_attention") as any;
  assert.equal(tool?._meta?.ui?.resourceUri, CARD_URI);
  const res = await a.readResource({ uri: CARD_URI });
  assert.equal(res.contents[0]?.mimeType, RESOURCE_MIME_TYPE);
  assert.deepEqual((res.contents[0] as any)._meta.ui.csp.connectDomains, []);

  const b = await connect({ client: new DemoZoomRoomsClient(), source: "demo", cardHtml: null });
  const plain = (await b.listTools()).tools.find((t) => t.name === "get_rooms_needing_attention") as any;
  assert.equal(plain?._meta?.ui, undefined);
});

test("card: the HTML loads nothing from the network (no links, remote scripts, images, fonts or imports)", () => {
  assert.doesNotMatch(CARD_HTML, /<link\b/i);
  assert.doesNotMatch(CARD_HTML, /<script[^>]+src=/i);
  assert.doesNotMatch(CARD_HTML, /<img\b/i);
  assert.doesNotMatch(CARD_HTML, /@import\b|@font-face\b/i);
  assert.doesNotMatch(CARD_HTML, /url\(\s*['"]?https?:/i);
});
