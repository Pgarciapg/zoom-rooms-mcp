import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { roomsNeedingAttention } from "./attention.ts";
import { attentionCard } from "./card-model.ts";
import { diagnoseRoom, diagnosisText } from "./diagnose.ts";
import { MAX_ATTENDEES } from "./move-to.ts";
import { diagnoseRooms } from "./diagnose-rooms.ts";
import { findFreeRoom } from "./free-room.ts";
import { CARD_HTML } from "./generated/card.ts";
import { EarlierDemoZoomRoomsClient, type ZoomRoomsClient } from "./client.ts";
import { compare, DETAIL_BUDGET_MS, defaultSnapshotPath, FileSnapshotStore, MemorySnapshotStore, nextSnapshot, readAccount, type Snapshot, type SnapshotStore } from "./changes.ts";
import { CARD_URI, SERVER_NAME, SERVER_VERSION } from "./version.ts";

export type Source = "zoom" | "demo";

export interface ServerOptions {
  client: ZoomRoomsClient;
  source: Source;
  /** Built attention card HTML. Defaults to the bundled card; pass null to serve the tools without it. */
  cardHtml?: string | null;
  /** Where what_changed keeps the last check. Default: demo keeps a seeded copy in memory; live a private file on this computer. */
  snapshots?: SnapshotStore;
  /** Fingerprint of the Zoom account (accountFingerprint), so two accounts are never compared. Required for live what_changed. */
  account?: string;
  now?: () => number;
  /** Longest any tool takes before it answers anyway (default ANSWER_BUDGET_MS). For tests. */
  answerBudgetMs?: number;
}

/**
 * Every tool answers within this, waits and Zoom paging included, so a default MCP client (60 s) always gets a reply
 * (Codex review, 11/25). Past it the tool answers with a clear "Zoom was too slow" error, and what_changed saves nothing.
 */
export const ANSWER_BUDGET_MS = 50_000;

const tooSlow = (ms: number) =>
  fail(new Error(`Zoom was too slow to answer within ${Math.round(ms / 1000)} s, so this call stopped before the chat app gives up. Nothing was saved or changed. Try again in a minute.`));

/** Runs a tool handler, but answers with tooSlow once the budget is spent. `late()` tells the handler it was cut off. */
const inTime =
  <A, R>(ms: number, run: (args: A, late: () => boolean, startedAt: number) => Promise<R>) =>
  async (args: A) => {
    const startedAt = Date.now();
    let cut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ms);
    });
    const work = Promise.resolve().then(() => run(args, () => cut, startedAt));
    work.catch(() => undefined);
    try {
      const got = await Promise.race([work, late]);
      if (got === "late") {
        cut = true;
        return tooSlow(ms);
      }
      return got as R;
    } finally {
      clearTimeout(timer);
    }
  };

/** Demo mode's saved previous check: the campus a day earlier. Never touches the real file. */
export const demoBaseline = async (now: number): Promise<Snapshot> => {
  const earlier = new EarlierDemoZoomRoomsClient();
  return nextSnapshot(await readAccount(earlier, null), null, "demo", now - 86_400_000);
};

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

/** what_changed writes only its own snapshot file on this computer; it never changes anything in Zoom. */
export const SAVES_LOCALLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const TOOL_NAMES = ["get_rooms_needing_attention", "what_changed", "diagnose_rooms", "diagnose_room", "find_free_room", "list_zoom_rooms", "get_zoom_room", "get_zoom_room_devices"] as const;

export const createServer = ({ client, source, cardHtml: cardOption, snapshots, account, now = Date.now, answerBudgetMs = ANSWER_BUDGET_MS }: ServerOptions): McpServer => {
  const budget = answerBudgetMs;
  let store: SnapshotStore | null = snapshots ?? null;
  let changesQueue: Promise<unknown> = Promise.resolve();
  const accountKey = source === "demo" ? "demo" : account;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const note = source === "demo" ? " (demo data: a fictional campus, not a real Zoom account)" : "";

  const cardHtml = cardOption === undefined ? CARD_HTML : cardOption;
  if (cardHtml) {
    // The card talks only to the host bridge; it loads nothing from the network.
    const resource = { uri: CARD_URI, mimeType: RESOURCE_MIME_TYPE, text: cardHtml, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } } };
    registerAppResource(server, "Zoom Rooms attention card", CARD_URI, { description: "Rooms needing attention, worst first, with each room's next step." }, async () => ({ contents: [resource] }));
  }

  const attentionConfig = {
    title: "Rooms needing attention",
    description: `Start here. Which Zoom Rooms need attention right now: problem rooms worst first (critical, then warning; offline rooms first), each with its open issues, the devices that are not online, whether a meeting is running in it now, and a plain next step. Rooms it could not read are listed apart, and it never reports all clear while something could not be read${note}.`,
    inputSchema: {},
    annotations: READ_ONLY,
  };
  const runAttention = inTime(budget, async () => {
    try {
      const result = await roomsNeedingAttention(client);
      // The card reads _meta.card; content and structuredContent are exactly what they are without the card.
      return { content: [{ type: "text" as const, text: result.summary }], structuredContent: { source, ...result } as Record<string, unknown>, _meta: { card: attentionCard(result, source) } };
    } catch (error) {
      return fail(error);
    }
  });
  if (cardHtml) registerAppTool(server, "get_rooms_needing_attention", { ...attentionConfig, _meta: { ui: { resourceUri: CARD_URI, visibility: ["model", "app"] } } }, runAttention);
  else server.registerTool("get_rooms_needing_attention", attentionConfig, runAttention);

  server.registerTool(
    "what_changed",
    {
      title: "What changed since the last check",
      description: `Compares the Zoom Rooms account with the last time this tool ran: rooms that went offline or came back, health that got worse or better, issues opened or closed, devices that dropped or recovered, and rooms added or removed, worst first. Then saves this check as the new starting point, in a private file on this computer only (nothing is sent anywhere and nothing in Zoom changes). The first run says there is nothing to compare yet. Anything that could not be read now or last time is listed as not compared, never as fixed or cleared${note}.`,
      inputSchema: { save: z.boolean().optional().describe("Save this check as the new starting point (default true). Set false to compare without moving it.") },
      annotations: SAVES_LOCALLY,
    },
    // One what_changed at a time (Codex review, 11/25): a slow older call finishing last would otherwise overwrite the
    // newer saved check. Each call waits for the one before it, then reads and saves on its own.
    // The wait behind an earlier call counts against this call's own budget (Codex review, 11/25).
    inTime(budget, ({ save = true }: { save?: boolean }, late, startedAt) => {
      // A call already answered "too slow" while it waited never reads Zoom, so retries never pile up (Sonnet review, 11/26).
      const run = changesQueue.then(() => (late() ? tooSlow(budget) : whatChanged(save, late, startedAt + Math.min(DETAIL_BUDGET_MS, budget * 0.8))));
      changesQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  );

  async function whatChanged(save: boolean, late: () => boolean, deadline: number) {
      try {
        const t = now();
        if (!accountKey) throw new Error("what_changed needs the Zoom account to keep its checks apart; start the server with credentials or --demo.");
        store ??= source === "demo" ? new MemorySnapshotStore(await demoBaseline(t)) : new FileSnapshotStore(defaultSnapshotPath(accountKey));
        let previous: Snapshot | null = null;
        let note2 = "";
        try {
          previous = store.load();
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          if (save && store instanceof FileSnapshotStore) note2 = `The earlier saved check could not be used: ${why}. It was kept as ${store.setAside(t)}, and this check starts fresh.`;
          else throw new Error(`Could not compare: ${why}.`);
        }
        if (previous && previous.account !== accountKey) throw new Error("The saved check belongs to a different Zoom account, so nothing was compared or saved. Point ZOOM_ROOMS_STATE at a file for this account.");
        const reading = await readAccount(client, previous, { deadline });
        const report = compare(reading, previous, t);
        let saved = save ? `This check was saved as the starting point for next time, in ${store.where}.` : "This check was not saved; the starting point is unchanged.";
        // This call already answered "too slow": never save a check nobody was shown.
        if (late()) save = false;
        if (save) {
          try {
            // Another copy of this server (a second chat or app) may have saved a newer check while this one read Zoom
            // (Codex review, 11/25). Never overwrite it: save only when the starting point is still the one compared.
            // The check and the save happen under one lock, so no other process can save in between.
            const s = store;
            const guarded = () => {
              let latest: unknown = null;
              try {
                latest = s.load();
              } catch {
                latest = undefined;
              }
              if (JSON.stringify(latest) !== JSON.stringify(previous)) throw new Error("another check was saved while this one was reading Zoom, so that newer one was kept");
              s.save(nextSnapshot(reading, previous, accountKey!, t));
            };
            if (s.exclusive) s.exclusive(guarded);
            else guarded();
          } catch (error) {
            saved = `This check could NOT be saved (${error instanceof Error ? error.message : String(error)}), so next time compares against the older check.`;
          }
        }
        const text = [report.text, ...(note2 ? ["", note2] : []), "", saved].join("\n");
        return { content: [{ type: "text" as const, text }], structuredContent: { source, summary: report.summary, firstRun: report.firstRun, changes: report.changes, notCompared: report.notCompared } as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
  }

  server.registerTool(
    "diagnose_rooms",
    {
      title: "Shared causes across Zoom Rooms",
      description: `Runs diagnose_room on every problem room and looks for causes they share: room computers offline on the same floor (often one switch or power circuit), the same device model failing in several rooms, failing devices of one kind on the same firmware, or the same kind of problem in several rooms. Shared causes come worst first with one check each, then a short per-room list. Rooms it could not read are listed apart, and it never reports all clear while something could not be read${note}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    inTime(budget, async () => {
      try {
        const result = await diagnoseRooms(client);
        return { content: [{ type: "text" as const, text: result.summary }], structuredContent: { source, ...result } as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    }),
  );

  server.registerTool(
    "diagnose_room",
    {
      title: "Diagnose one Zoom Room",
      description: `Why one Zoom Room is unhappy and what to check first: the room computer, each open issue and each device that is not online, with an issue and the failing device it describes joined into one finding, worst first, each with one check. Says whether a meeting is running in it now and, for a room with a problem, names up to three other rooms in the same Zoom location that are healthy and free right now, each with its seats when Zoom gives them. Pass attendees (the meeting size) to see whether each room fits it; rooms that fit are named first. Without a meeting size, or when Zoom gives no seats for a room, it says "capacity not compared" and never guesses a fit. Anything it could not read is listed apart, and it never reports all clear while something could not be read${note}.`,
      inputSchema: {
        roomId,
        attendees: z.number().int().min(1).max(MAX_ATTENDEES).optional().describe("How many people are in the meeting, if known. Used only to say whether each free room's seats fit; never guessed."),
      },
      annotations: READ_ONLY,
    },
    inTime(budget, async ({ roomId, attendees }: { roomId: string; attendees?: number }) => {
      try {
        const result = await diagnoseRoom(client, roomId, undefined, undefined, undefined, { moveTo: true, attendees });
        return { content: [{ type: "text" as const, text: diagnosisText(result) }], structuredContent: { source, ...result } as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    }),
  );

  server.registerTool(
    "find_free_room",
    {
      title: "Find a free Zoom Room",
      description: `Rooms that are free (not in a meeting) and healthy right now in Zoom's room list, each with its seats from Zoom. Pass near (a room's name or id, or a place such as a floor or building by its Zoom location name) for rooms in the same Zoom location only, and attendees (the meeting size) to put rooms that fit first, smallest first; without seats in Zoom a room says "capacity not compared", never a guessed fit. It only reads and books nothing; Zoom's room list does not show later bookings, so it says to check the room's calendar${note}.`,
      inputSchema: {
        attendees: z.number().int().min(1).max(MAX_ATTENDEES).optional().describe("How many people need the room, if known. Used only to compare with each room's seats; never guessed."),
        near: z.string().min(1).max(200).optional().describe("A room's name or id (free rooms in the same Zoom location), or a place by its Zoom location name, like \"Building 1, 3rd Floor\" or \"Building 1\""),
      },
      annotations: READ_ONLY,
    },
    inTime(budget, async ({ attendees, near }: { attendees?: number; near?: string }) => {
      try {
        const result = await findFreeRoom(client, { attendees, near });
        return { content: [{ type: "text" as const, text: result.summary }], structuredContent: { source, ...result } as Record<string, unknown> };
      } catch (error) {
        return fail(error);
      }
    }),
  );

  server.registerTool(
    "list_zoom_rooms",
    {
      title: "List Zoom Rooms",
      description: `List every Zoom Room in the account with its status (Available, In Meeting, Offline) and health (Healthy, Warning, Critical)${note}.`,
      inputSchema: {},
      annotations: READ_ONLY,
    },
    inTime(budget, guard(() => client.listRooms(), source)),
  );

  server.registerTool(
    "get_zoom_room",
    {
      title: "Get Zoom Room",
      description: `Details for one Zoom Room: location, health and any open issues${note}.`,
      inputSchema: { roomId },
      annotations: READ_ONLY,
    },
    inTime(budget, guard(({ roomId }: { roomId: string }) => client.getRoom(roomId), source)),
  );

  server.registerTool(
    "get_zoom_room_devices",
    {
      title: "Get Zoom Room devices",
      description: `Devices in one Zoom Room (cameras, microphones, speakers, controllers, displays) with status and firmware${note}.`,
      inputSchema: { roomId },
      annotations: READ_ONLY,
    },
    inTime(budget, guard(({ roomId }: { roomId: string }) => client.getRoomDevices(roomId), source)),
  );

  return server;
};
