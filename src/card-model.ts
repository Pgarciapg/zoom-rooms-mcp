// Card data for get_rooms_needing_attention (MCP App, 2026-11-17). A straight copy of the tool result: the card never
// re-ranks, re-classes or re-words a room, so it can never show something the text answer does not. The card gets this
// through the tool result's _meta; content and structuredContent are unchanged.
import type { Attention, AttentionRoom } from "./attention.ts";
import type { Source } from "./server.ts";

export interface AttentionCard {
  kind: "attention";
  source: Source;
  /** The first line of the text answer, word for word. */
  headline: string;
  total: number;
  needAttention: number;
  counts: Attention["counts"];
  rooms: AttentionRoom[];
  notReadInDetail: string[];
  couldNotCheck: string[];
  allClear: boolean;
}

export const attentionCard = (result: Attention, source: Source): AttentionCard => ({
  kind: "attention",
  source,
  headline: result.summary.split("\n")[0] ?? "",
  total: result.total,
  needAttention: result.needAttention,
  counts: { ...result.counts },
  rooms: result.rooms.map((r) => ({ ...r, issues: r.issues.map((i) => ({ ...i })), devices: [...r.devices] })),
  notReadInDetail: [...result.notReadInDetail],
  couldNotCheck: [...result.couldNotCheck],
  allClear: result.allClear,
});
