# zoom-rooms-mcp

An [MCP](https://modelcontextprotocol.io) server for **Zoom Rooms**. Ask Claude, Cursor, or any MCP client "which rooms have problems right now?" and get an answer from your Zoom account: room status, health, open issues and the devices in each room.

- **Read-only by design.** All 4 tools are annotated `readOnlyHint: true`. Nothing changes in Zoom.
- **Runs without an account.** `--demo` serves a fictional 32-room campus, so you can try it before you have credentials. With no credentials set it starts in demo mode on its own.
- **Local and simple.** One stdio server you run yourself. No website, no hosted service, no sign-in.
- **Per-account token cache.** Server-to-Server OAuth tokens are cached per account and client, never shared across credentials.

## Try it (no Zoom account)

```bash
git clone https://github.com/Pgarciapg/zoom-rooms-mcp && cd zoom-rooms-mcp
npm install && npm run build
node dist/cli.js --demo
```

## Add it to Claude

**Claude Code**

```bash
claude mcp add zoom-rooms \
  -e ZOOM_ACCOUNT_ID=... -e ZOOM_CLIENT_ID=... -e ZOOM_CLIENT_SECRET=... \
  -- node /path/to/zoom-rooms-mcp/dist/cli.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "zoom-rooms": {
      "command": "node",
      "args": ["/path/to/zoom-rooms-mcp/dist/cli.js"],
      "env": {
        "ZOOM_ACCOUNT_ID": "...",
        "ZOOM_CLIENT_ID": "...",
        "ZOOM_CLIENT_SECRET": "..."
      }
    }
  }
}
```

Leave out `env` to run on demo data.

## Zoom credentials

Create a **Server-to-Server OAuth** app at [marketplace.zoom.us](https://marketplace.zoom.us) and add the Zoom Rooms **read** scopes for listing rooms, room details and room devices (the app's Scopes page lists them). Then set:

| Variable | What it is |
|---|---|
| `ZOOM_ACCOUNT_ID` | Account ID from the app's credentials page |
| `ZOOM_CLIENT_ID` | Client ID |
| `ZOOM_CLIENT_SECRET` | Client secret |
| `ZOOM_CREDENTIALS_FILE` | Optional. A dotenv file holding the three values above. Environment variables win. |
| `ZOOM_API_BASE_URL` | Optional. Defaults to `https://api.zoom.us/v2`. |

If only some of the three are set, the server refuses to start and names what is missing, so a typo never quietly drops you into demo mode.

## Tools

| Tool | Zoom API | Returns |
|---|---|---|
| `get_rooms_needing_attention` | `GET /rooms`, then `GET /rooms/{roomId}` and `/devices` for each problem room | Start here: problem rooms worst first, with open issues, devices not online, whether a meeting is running now, and a plain next step. Never an all-clear while something could not be read |
| `list_zoom_rooms` | `GET /rooms` | Every room with status and health |
| `get_zoom_room` | `GET /rooms/{roomId}` | One room's details and open issues |
| `get_zoom_room_devices` | `GET /rooms/{roomId}/devices` | Cameras, mics, speakers, controllers, displays |

Each result has the raw JSON as text plus `structuredContent: { source: "zoom" | "demo", data }`. Unknown rooms come back as a clean tool error.

## Development

```bash
npm run typecheck
npm test          # builds, then unit tests plus an end-to-end stdio run of the CLI
```

## About

Built by [Downriver Labs](https://downriverlabs.com), which builds MCP connectors that connect a business's own systems to AI assistants. Sister project: [qsys-reflect-mcp](https://github.com/Pgarciapg/qsys-reflect-mcp) for Q-SYS Reflect.

MIT license.
