import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DemoZoomRoomsClient, HttpZoomRoomsClient } from "../src/client.ts";
import { createServer, TOOL_NAMES } from "../src/server.ts";

type Result = { content: { type: string; text: string }[]; structuredContent?: any; isError?: boolean };

const connect = async () => {
  const server = createServer({ client: new DemoZoomRoomsClient(), source: "demo" });
  const client = new Client({ name: "zoom-rooms-test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
};
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as Result;

test("lists exactly the seven tools, all read-only except what_changed", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of tools) {
    assert.equal(tool.annotations?.readOnlyHint, tool.name !== "what_changed", tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    assert.match(tool.description ?? "", /demo data/, "demo mode is disclosed in descriptions");
  }
});

test("list_zoom_rooms returns the 32-room demo campus", async () => {
  const client = await connect();
  const result = await call(client, "list_zoom_rooms");
  assert.ok(!result.isError);
  assert.equal(result.structuredContent.source, "demo");
  assert.equal(result.structuredContent.data.rooms.length, 32);
  assert.equal(JSON.parse(result.content[0]!.text).total_records, 32);
});

test("get_zoom_room returns issues for a problem room and a clean record for a healthy one", async () => {
  const client = await connect();
  const bad = await call(client, "get_zoom_room", { roomId: "rm-001" });
  assert.equal(bad.structuredContent.data.health, "Critical");
  assert.equal(bad.structuredContent.data.issues[0].severity, "critical");

  const ok = await call(client, "get_zoom_room", { roomId: "huddle-a" });
  assert.equal(ok.structuredContent.data.name, "Huddle A");
  assert.deepEqual(ok.structuredContent.data.issues, []);
});

test("get_zoom_room_devices lists devices", async () => {
  const client = await connect();
  const result = await call(client, "get_zoom_room_devices", { roomId: "rm-002" });
  const mic = result.structuredContent.data.devices.find((d: any) => d.device_type === "Microphone");
  assert.equal(mic.status, "Offline");
  const generic = await call(client, "get_zoom_room_devices", { roomId: "rm-010" });
  assert.ok(generic.structuredContent.data.devices.length >= 2);
});

test("an unknown room is a clean tool error, not a made-up room", async () => {
  const client = await connect();
  for (const name of ["get_zoom_room", "get_zoom_room_devices"]) {
    const result = await call(client, name, { roomId: "nope-999" });
    assert.equal(result.isError, true, name);
    assert.match(result.content[0]!.text, /Room not found: nope-999/);
  }
});

test("live client URL-encodes room ids and surfaces Zoom errors", async (t) => {
  const seen: string[] = [];
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  globalThis.fetch = (async (url: string | URL) => {
    seen.push(String(url));
    if (String(url).includes("/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "t", token_type: "bearer", expires_in: 3600 }), { status: 200 });
    }
    return new Response('{"code":3001,"message":"Room does not exist"}', { status: 404 });
  }) as typeof fetch;

  const client = new HttpZoomRoomsClient({ accountId: "enc-acct", clientId: "enc-client", clientSecret: "enc-secret" });
  await assert.rejects(client.getRoomDevices("a/b?c"), /Zoom API 404 on \/rooms\/a%2Fb%3Fc\/devices/);
  assert.equal(seen.at(-1), "https://api.zoom.us/v2/rooms/a%2Fb%3Fc/devices");
});
