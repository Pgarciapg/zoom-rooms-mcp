// End-to-end over stdio against the built CLI (npm test builds first), the way Claude Desktop runs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SERVER_VERSION } from "../src/version.ts";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
// Strip any real Zoom credentials from the parent shell so the test never calls Zoom.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k, v]) => !k.startsWith("ZOOM_") && v !== undefined)) as Record<string, string>;

test("--help and --version", () => {
  assert.match(execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" }), /ZOOM_CLIENT_SECRET/);
  assert.equal(execFileSync(process.execPath, [CLI, "--version"], { encoding: "utf8" }).trim(), SERVER_VERSION);
});

test("with no credentials it starts in demo mode over stdio and answers all three tools", async () => {
  const client = new Client({ name: "cli-test", version: "0.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env: cleanEnv(), stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, "zoom-rooms-mcp");
    const rooms = (await client.callTool({ name: "list_zoom_rooms", arguments: {} })) as any;
    assert.equal(rooms.structuredContent.source, "demo");
    for (const name of ["get_zoom_room", "get_zoom_room_devices"]) {
      const r = (await client.callTool({ name, arguments: { roomId: "rm-001" } })) as any;
      assert.ok(!r.isError, name);
    }
    assert.match(stderr, /serving demo data/);
  } finally {
    await client.close();
  }
});

test("partial credentials refuse to start instead of falling back to demo", () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI], { env: { ...cleanEnv(), ZOOM_ACCOUNT_ID: "only-this" }, stdio: "pipe", input: "" }),
    (e: any) => /missing ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET/.test(String(e.stderr)),
  );
});
