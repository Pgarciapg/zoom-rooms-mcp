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

/**
 * Builds a place name from a location tree. `cut` is true when the parent chain stops at a parent that is not in the
 * tree (an unread page or an orphan), so the name may be missing its building. A loop in bad data just stops. Exported for tests.
 */
export const placeName = (tree: Map<string, LocationRow>, id: string): { name: string | null; cut: boolean } => {
  if (!tree.has(id)) return { name: null, cut: false };
  const chain: LocationRow[] = [];
  const seen = new Set<string>();
  let at = id;
  while (at && tree.has(at) && !seen.has(at) && chain.length < MAX_DEPTH) {
    seen.add(at);
    const row = tree.get(at)!;
    chain.push(row);
    at = row.parent;
  }
  // A country is Zoom's top level, and its parent is the account id, which is never a location row (Codex review, 11/25):
  // a chain that reaches a country is whole, not cut.
  const top = chain.at(-1);
  const cut = Boolean(at) && !tree.has(at) && !(top && /^countr(y|ies)$/i.test(top.type));
  const named = chain.filter((r) => r.name);
  const site = named.filter((r) => !REGION.test(r.type));
  // The two closest levels read best ("Building 1, 4th Floor"); the code, not the name, keeps places apart.
  const parts = (site.length ? site : named).slice(0, 2).map((r) => r.name).reverse();
  return { name: parts.length ? parts.join(", ") : null, cut };
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

type Label = { text: string; issue: "missing" | "unnamed" | "partial" | null };

/**
 * Turns location codes into place names for one tool call. The location list is read at most once, and only when a
 * code needs a name. Names are worked out for the whole tree at once, so two places that would read the same (two
 * "Floor 1"s with no building, or the same building and floor under two campuses) get their code added and never look
 * like one place. Call note() after the lookups: it says why any place shows a code or a partial name, or null.
 */
export class PlaceNamer {
  private readonly client: ZoomRoomsClient;
  private loading: Promise<{ labels: Map<string, Label>; problem: string | null }> | null = null;
  private readonly shown = new Map<string, Label["issue"]>();
  private problem: string | null = null;

  constructor(client: ZoomRoomsClient) {
    this.client = client;
  }

  private async load() {
    const { tree, problem } = await readTree(this.client);
    const base = new Map<string, { name: string | null; cut: boolean }>();
    const count = new Map<string, number>();
    for (const id of tree.keys()) {
      const b = placeName(tree, id);
      base.set(id, b);
      if (b.name) count.set(b.name.toLowerCase(), (count.get(b.name.toLowerCase()) ?? 0) + 1);
    }
    const labels = new Map<string, Label>();
    for (const [id, b] of base) {
      if (!b.name) labels.set(id, { text: id, issue: "unnamed" });
      else if (b.cut) labels.set(id, { text: `${b.name} (location ${id})`, issue: "partial" });
      else if ((count.get(b.name.toLowerCase()) ?? 0) > 1) labels.set(id, { text: `${b.name} (location ${id})`, issue: null });
      else labels.set(id, { text: b.name, issue: null });
    }
    return { labels, problem };
  }

  /** The place for a location code: its name, or the code itself, and whether a note explains it. */
  async lookup(code: string): Promise<Label> {
    if (!code) return { text: code, issue: null };
    this.loading ??= this.load();
    const { labels, problem } = await this.loading;
    this.problem = problem;
    const label = labels.get(code) ?? { text: code, issue: "missing" as const };
    this.shown.set(code, label.issue);
    return label;
  }

  /** The place name for a location code, or the code itself when no name is known. */
  async name(code: string): Promise<string> {
    return (await this.lookup(code)).text;
  }

  /** Why any place shown so far (or only the given codes) is a code or a partial name, or null when none is. */
  note(codes?: string[]): string | null {
    const shown = [...this.shown].filter(([code]) => !codes || codes.includes(code)).map(([, issue]) => issue);
    const n = (issue: Label["issue"]) => shown.filter((i) => i === issue).length;
    const missing = n("missing");
    const unnamed = n("unnamed");
    const partial = n("partial");
    if (!missing && !unnamed && !partial) return null;
    const places = (k: number, what: string) => (k === 1 ? `1 place is ${what}` : `${k} places are ${what}`);
    const it = (k: number) => (k === 1 ? "it" : "they");
    const more = this.problem?.startsWith("Zoom has more pages");
    const parts: string[] = [];
    if (missing) {
      const shown = places(missing, missing === 1 ? "shown as its Zoom location code" : "shown as their Zoom location codes");
      if (this.problem && !more) parts.push(`${shown} because ${this.problem}.`);
      else if (more) parts.push(`${shown}; ${this.problem}, so ${it(missing)} may be on a page not read.`);
      else parts.push(`${shown} because Zoom's location list does not include ${missing === 1 ? "it" : "them"}.`);
    }
    if (unnamed) parts.push(`${places(unnamed, unnamed === 1 ? "shown as its Zoom location code" : "shown as their Zoom location codes")} because Zoom has no name for ${unnamed === 1 ? "it" : "them"}.`);
    if (partial) parts.push(`${places(partial, "shown with only part of the name, plus the location code,")} because a parent location is missing from Zoom's location list${more ? " (it has more pages than were read)" : ""}.`);
    return `Place names: ${parts.join(" ")} Grouping by place is not affected.`;
  }
}

/**
 * A place someone named (2026-11-24): every location in the tree whose own name, or whose place name ("Building 1, 3rd
 * Floor"), matches, with the room location codes at or under it. A match inside another match is the same place. More
 * than one place with rooms is ambiguous (the caller asks which). `problem` says when the list could not be fully read.
 */
export const findPlace = async (
  client: ZoomRoomsClient,
  want: (text: string) => boolean,
  roomCodes: string[],
): Promise<{ places: { label: string; codes: string[]; id: string; within: string }[]; read: boolean; problem: string | null }> => {
  const { tree, problem } = await readTree(client);
  if (!tree.size) return { places: [], read: false, problem };
  const ancestors = (id: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let at = id;
    while (at && tree.has(at) && !seen.has(at) && out.length < MAX_DEPTH) {
      seen.add(at);
      out.push(at);
      at = tree.get(at)!.parent;
    }
    return out;
  };
  // A Zoom location code matches too, so two places with one label can be told apart by code (Codex review, 11/24).
  const matched = [...tree.keys()].filter((id) => want(tree.get(id)!.name) || want(placeName(tree, id).name ?? "") || want(id));
  // A match inside another match (a floor named like its building) is the outer place.
  const outer = matched.filter((id) => !ancestors(id).slice(1).some((a) => matched.includes(a)));
  const places = outer
    .map((id) => ({
      label: placeName(tree, id).name ?? tree.get(id)!.name ?? id,
      codes: roomCodes.filter((c) => ancestors(c).includes(id)),
      id,
      // The levels above the label (campus, city, country), to tell two same-named places apart.
      within: ancestors(id).slice(1).map((a) => tree.get(a)!.name).filter(Boolean).filter((n) => !(placeName(tree, id).name ?? "").includes(n)).join(", "),
    }))
    .filter((p) => p.codes.length > 0);
  return { places, read: true, problem };
};
