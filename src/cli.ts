#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DEFAULT_BASE_URL, DemoZoomRoomsClient, HttpZoomRoomsClient } from "./client.ts";
import { loadCredentials } from "./credentials.ts";
import { createServer } from "./server.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

Read-only MCP server for Zoom Rooms: rooms, health, issues and devices. Runs over stdio.

Usage: ${SERVER_NAME} [--demo]

  --demo   Serve a fictional 32-room campus instead of calling Zoom (no credentials needed)

Environment (a Zoom Server-to-Server OAuth app with room read scopes):
  ZOOM_ACCOUNT_ID         Account ID
  ZOOM_CLIENT_ID          Client ID
  ZOOM_CLIENT_SECRET      Client secret
  ZOOM_CREDENTIALS_FILE   Optional dotenv file holding the three values above
  ZOOM_API_BASE_URL       Override the API base (default ${DEFAULT_BASE_URL})

With no credentials set, the server starts in demo mode.
`;

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (argv.includes("--version")) {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}

const creds = loadCredentials();
const demo = argv.includes("--demo") || !creds;
if (!argv.includes("--demo") && !creds) console.error("No Zoom credentials set; serving demo data. Pass --demo to silence this.");

const server = createServer({
  client: demo ? new DemoZoomRoomsClient() : new HttpZoomRoomsClient(creds!, process.env.ZOOM_API_BASE_URL),
  source: demo ? "demo" : "zoom",
});
await server.connect(new StdioServerTransport());
console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio (${demo ? "demo" : "live Zoom"})`);
