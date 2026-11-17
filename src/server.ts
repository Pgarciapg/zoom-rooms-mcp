import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roomsNeedingAttention } from "./attention.ts";
import type { ZoomRoomsClient } from "./client.ts";
import { SERVER_NAME, SERVER_VERSION } from "./version.ts";

export type Source = "zoom" | "demo";

export interface ServerOptions {
  client: ZoomRoomsClient;
  source: Source;
}

/** Every tool only reads from Zoom. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const roomId = z.string().min(1).describe("Zoom Room id (the `id` from list_zoom_rooms)");

const json = (data: unknown, source: Source) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  structuredContent: { source, data } as Record<string, unknown>,
});

const fail = (error: unknown) => ({
  content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  isError: true,
});

const guard =
  <A>(run: (args: A) => Promise<unknown>, source: Source) =>
  async (args: A) => {
    try {
      return json(await run(args), source);
    } catch (error) {
      return fail(error);
    }
  };

export const TOOL_NAMES = ["get_rooms_needing_attention", "list_zoom_rooms", "get_zoom_room", "get_zoom_room_devices"] as const;

export const createServer = ({ client, source }: ServerOptions): McpServer => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const note = source === "demo" ? " (demo data: a fictional campus, not a real Zoom account)" : "";

  server.registerTool(
    "get_rooms_needing_attention",
    {
      title: "Rooms needing attention",
      description: `Start here. Which Zoom Rooms need attention right now: problem rooms worst first (critical, then warning; offline rooms first), each with its open issues, the devices that are not online, whether a meeting is running in it now, and a plain next step. Rooms it could not read are listed apart, and it never reports all clear while something could not be read${note}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const result = await roomsNeedingAttention(client);
        return { content: [{ type: "text" as const, text: result.summary }], structuredContent: { source, ...result } as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_zoom_rooms",
    {
      title: "List Zoom Rooms",
      description: `List every Zoom Room in the account with its status (Available, In Meeting, Offline) and health (Healthy, Warning, Critical)${note}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    guard(() => client.listRooms(), source),
  );

  server.registerTool(
    "get_zoom_room",
    {
      title: "Get Zoom Room",
      description: `Details for one Zoom Room: location, health and any open issues${note}.`,
      inputSchema: { roomId },
      annotations: READ_ONLY,
    },
    guard(({ roomId }: { roomId: string }) => client.getRoom(roomId), source),
  );

  server.registerTool(
    "get_zoom_room_devices",
    {
      title: "Get Zoom Room devices",
      description: `Devices in one Zoom Room (cameras, microphones, speakers, controllers, displays) with status and firmware${note}.`,
      inputSchema: { roomId },
      annotations: READ_ONLY,
    },
    guard(({ roomId }: { roomId: string }) => client.getRoomDevices(roomId), source),
  );

  return server;
};
