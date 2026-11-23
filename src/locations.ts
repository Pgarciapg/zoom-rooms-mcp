// Readable place names for Zoom Rooms.
//
// Zoom's room list carries only a location_id code (for example "49D7a0xPQvGQ2DCMZgSe7w"). Zoom keeps the names in a
// separate location tree: GET /rooms/locations returns every location with its name, type (country, states, city,
// campus, building, floor) and parent. This turns a code into "Building 1, 4th Floor".
//
// Names are for showing only. Rooms are still grouped by the code, so two floors with the same name in different
// buildings never merge. A location list that cannot be read never changes an all-clear: places keep their codes and
// the reply says why.

import type { ZoomRoomsClient } from "./client.ts";

interface LocationRow {
  name: string;
  parent: string;
  type: string;
}

/** Location types above a site. Left out of a place name when the chain also has a campus, building or floor. */
const REGION = /^(country|countries|states?|city|cities)$/i;
/** The longest parent chain followed. Zoom's tree is at most six levels; this also stops a loop in bad data. */
const MAX_DEPTH = 10;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const msg = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Builds a place name from a location tree. Exported for tests. */
export const placeName = (tree: Map<string, LocationRow>, id: string): string | null => {
  if (!tree.has(id)) return null;
  const chain: LocationRow[] = [];
  const seen = new Set<string>();
  let at = id;
  while (at && tree.has(at) && !seen.has(at) && chain.length < MAX_DEPTH) {
    seen.add(at);
    const row = tree.get(at)!;
    chain.push(row);
    at = row.parent;
  }
  const named = chain.filter((r) => r.name);
  const site = named.filter((r) => !REGION.test(r.type));
  // The two closest levels read best ("Building 1, 4th Floor"); the code, not the name, keeps places apart.
  const parts = (site.length ? site : named).slice(0, 2).map((r) => r.name).reverse();
  return parts.length ? parts.join(", ") : null;
};

/** Reads the location tree into a map, or says why it could not. */
const readTree = async (client: ZoomRoomsClient): Promise<{ tree: Map<string, LocationRow>; problem: string | null }> => {
  const tree = new Map<string, LocationRow>();
  if (!client.listLocations) return { tree, problem: "this connection cannot read Zoom's location list" };
  let got: any;
  try {
    got = await client.listLocations();
  } catch (error) {
    return { tree, problem: `Zoom's location list could not be read (${msg(error)})` };
  }
  const raw = Array.isArray(got) ? got : got?.locations;
  if (!Array.isArray(raw)) return { tree, problem: "Zoom's location list came back in an unexpected shape" };
  for (const r of raw) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) continue;
    const id = str(r.id);
    if (id) tree.set(id, { name: str(r.name), parent: str(r.parent_location_id), type: str(r.type) });
  }
  const more = !Array.isArray(got) && str(got?.next_page_token) ? "Zoom has more pages of locations than were read" : null;
  return { tree, problem: more };
};

/**
 * Turns location codes into place names for one tool call. The location list is read at most once, and only when a
 * code needs a name. Call note() after the lookups: it says why any place still shows a code, or null when none does.
 */
export class PlaceNamer {
  private readonly client: ZoomRoomsClient;
  private loading: Promise<{ tree: Map<string, LocationRow>; problem: string | null }> | null = null;
  private readonly unnamed = new Set<string>();
  private problem: string | null = null;
  private loaded = false;

  constructor(client: ZoomRoomsClient) {
    this.client = client;
  }

  /** The place name for a location code, or the code itself when no name is known. */
  async name(code: string): Promise<string> {
    if (!code) return code;
    this.loading ??= readTree(this.client);
    const { tree, problem } = await this.loading;
    this.loaded = true;
    this.problem = problem;
    const found = placeName(tree, code);
    if (found) return found;
    this.unnamed.add(code);
    return code;
  }

  /** Why any place is still shown as a code, or null. */
  note(): string | null {
    if (!this.loaded || this.unnamed.size === 0) return null;
    const n = this.unnamed.size;
    const codes = n === 1 ? "1 place is shown as its Zoom location code" : `${n} places are shown as their Zoom location codes`;
    if (this.problem && !this.problem.startsWith("Zoom has more pages")) return `Place names: ${codes} because ${this.problem}. Grouping by place is not affected.`;
    if (this.problem) return `Place names: ${codes}; ${this.problem}, so ${n === 1 ? "it" : "they"} may be on a page not read. Grouping by place is not affected.`;
    return `Place names: ${codes} because Zoom's location list does not include ${n === 1 ? "it" : "them"}. Grouping by place is not affected.`;
  }
}
