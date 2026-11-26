// "Where can this meeting go?" (2026-11-23). One rule for diagnose_room and get_rooms_needing_attention: other rooms
// with the same Zoom location code that are Available and Healthy in Zoom's room list. Same code only, never a guess
// across floors or buildings (and a code can be a whole building, so callers say "same Zoom location", not a floor).

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? "" : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Most free rooms named; the rest are counted. */
export const MOVE_TO_LIMIT = 3;

/** A room name as shown in a one-line suggestion: no line breaks or control characters, short. */
export const cleanName = (n: string) => n.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60);

/**
 * Free in Zoom's room list: Available, and Healthy or no health given. Zoom's documented room list has no `health`
 * field (11/24 review), so a missing one cannot rule a room out; only a reported Warning, Critical or other value does.
 */
export const isFreeNow = (r: Record<string, unknown>) => /^available$/i.test(str(r.status)) && (!str(r.health) || /^healthy$/i.test(str(r.health)));

/** Free, healthy rooms in the given location codes, not the room itself, deduped by id, sorted by name. */
export const freeRoomsIn = (rooms: unknown[], self: Set<string>, locations: Set<string>): { id: string; name: string }[] => {
  const seen = new Set<string>();
  return rooms
    .filter(isObj)
    .filter((r) => !!(str(r.id) || str(r.room_id)) && !self.has(str(r.id)) && !self.has(str(r.room_id)))
    .filter((r) => locations.has(str(r.location_id)) && isFreeNow(r))
    .map((r) => {
      const id = str(r.id) || str(r.room_id);
      return { id, name: cleanName(str(r.name)) || cleanName(id) || "Unnamed room", noHealth: !str(r.health) };
    })
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    // Rooms Zoom calls Healthy before rooms with no health given; then "Room 2" before "Room 10".
    .sort((a, b) => Number(a.noHealth) - Number(b.noHealth) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    // Two free rooms here with the same name: add Zoom's room id, so a meeting is not moved into the wrong one. The id
    // suffix always ends the name (callers check endsWith), so the no-health marker goes before it.
    .map(({ noHealth, ...r }, _i, all) => {
      const name = noHealth ? `${r.name} (Zoom gives no health)` : r.name;
      return { ...r, name: all.filter((o) => o.name.toLowerCase() === r.name.toLowerCase()).length > 1 ? `${name} (Zoom room ${cleanName(r.id)})` : name };
    });
};

/** "A", "A and B", "A, B and C". */
const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Several meetings displaced at once (2026-11-23): give each a different free room, in the order given (worst room
 * first), so two meetings are never sent to the same room. Each room's list is its own pick first, then free rooms no
 * other meeting was given or has as a backup. A room whose free rooms were all given away gets a note naming them and who they went to,
 * instead of an empty or shared suggestion. Rooms with no candidates at all get no note.
 */
export const allocateMoveTo = (
  wanted: { name: string; candidates: { id: string; name: string }[] }[],
): { moveTo: { id: string; name: string }[]; moveToNote: string | null }[] => {
  const givenTo = new Map<string, string>(); // free room id -> the meeting room it was suggested for
  // Two problem rooms with the same name ("Lobby" in two buildings) are told apart by their number in the list, which
  // is the same order as this one.
  const nameCount = new Map<string, number>();
  for (const w of wanted) nameCount.set(cleanName(w.name).toLowerCase(), (nameCount.get(cleanName(w.name).toLowerCase()) ?? 0) + 1);
  const label = (name: string, i: number) => {
    const n = cleanName(name) || "another room";
    return (nameCount.get(cleanName(name).toLowerCase()) ?? 0) > 1 ? `${n} (number ${i + 1} in this list)` : n;
  };
  // As many meetings as possible get a room of their own (a maximum matching, by augmenting paths), worst room first:
  // a meeting once seated stays seated, though it may be moved to another of its rooms to seat a later one. The greedy
  // pick could strand one (A: X/Y, B: X/Z, C: X/Z, D: Y/W seats only three; this seats all four; Codex review, 11/25).
  // Each meeting tries first the room fewest later meetings could use, ties in name order.
  const order = wanted.map(({ candidates }, i) => {
    const later = (id: string) => wanted.slice(i + 1).filter((w) => w.candidates.some((c) => c.id === id)).length;
    return [...new Map(candidates.map((c) => [c.id, c])).values()].map((c, k) => ({ c, k, n: later(c.id) })).sort((a, b) => a.n - b.n || a.k - b.k).map((x) => x.c);
  });
  const holder = new Map<string, number>(); // free room id -> index of the meeting it is given to
  const picks: ({ id: string; name: string } | null)[] = wanted.map(() => null);
  const seat = (i: number, tried: Set<string>): boolean => {
    // A room nobody holds first, so no seated meeting is moved without need; only then move one along.
    const open = order[i]!.find((c) => !tried.has(c.id) && !holder.has(c.id));
    if (open) {
      tried.add(open.id);
      holder.set(open.id, i);
      picks[i] = open;
      return true;
    }
    for (const c of order[i]!) {
      if (tried.has(c.id)) continue;
      tried.add(c.id);
      const h = holder.get(c.id);
      if (h === undefined || seat(h, tried)) {
        holder.set(c.id, i);
        picks[i] = c;
        return true;
      }
    }
    return false;
  };
  wanted.forEach((_, i) => seat(i, new Set()));
  picks.forEach((pick, i) => pick && givenTo.set(pick.id, label(wanted[i]!.name, i)));
  // Backups (after a meeting's own pick) are spare rooms nobody was given, and each spare backs up one meeting only, worst
  // room first, so two meetings never fall back to the same room. A later meeting can get fewer backups, never a shared one.
  const backedUp = new Set<string>();
  return wanted.map(({ candidates }, i) => {
    const pick = picks[i];
    if (pick) {
      const backups: { id: string; name: string }[] = [];
      for (const c of candidates) {
        if (backups.length >= MOVE_TO_LIMIT - 1) break;
        if (c.id === pick.id || givenTo.has(c.id) || backedUp.has(c.id)) continue;
        backedUp.add(c.id);
        backups.push(c);
      }
      return { moveTo: [pick, ...backups], moveToNote: null };
    }
    if (!candidates.length) return { moveTo: [], moveToNote: null };
    const takers = [...new Set(candidates.map((c) => givenTo.get(c.id)!))];
    const shown = candidates.slice(0, MOVE_TO_LIMIT).map((c) => c.name).join(", ") + (candidates.length > MOVE_TO_LIMIT ? `, +${candidates.length - MOVE_TO_LIMIT} more` : "");
    const note = candidates.length === 1
      ? `the only free room in the same Zoom location, ${candidates[0]!.name}, is suggested for ${joinNames(takers)}`
      : `the ${candidates.length} free rooms in the same Zoom location (${shown}) are suggested for ${joinNames(takers)}`;
    return { moveTo: [], moveToNote: note };
  });
};

// Room size on the suggestion (2026-11-24). Zoom gives a room's seats on its room profile (Get Zoom Room profile,
// `basic.capacity`, 1 to 500). It gives no simple count of who is in a meeting, so the meeting size is only what the
// person says. Whenever either number is missing or unreadable, the answer is "capacity not compared", never a guessed fit.

export type Fit = "fits" | "too_small" | "not_compared";
export interface RoomFit {
  id: string;
  /** Seats, from Zoom's room profile; null when Zoom gives none or it could not be read. */
  capacity: number | null;
  fit: Fit;
  /** Plain words, e.g. "seats 12, fits 10 people" or "capacity not compared: Zoom gives no capacity for it". */
  text: string;
}

/** Free rooms whose size is looked up when a meeting size is given (each is one Zoom call). */
export const FIT_LOOKUP_LIMIT = 10;
/** The largest meeting size accepted (Zoom room capacity tops out at 500). */
export const MAX_ATTENDEES = 1000;

/** Seats from a Zoom room profile (`basic.capacity`): a whole number from 1 to 500, else null. */
export const readCapacity = (profile: unknown): number | null => {
  const raw = isObj(profile) && isObj(profile.basic) ? profile.basic.capacity : undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*\d{1,4}\s*$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
};

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** Compare a room's seats with the meeting size. Missing or unreadable on either side is "not compared". */
/**
 * Without a meeting size, the problem room's own seats (when Zoom gives them) are the next best hint: a suggestion with
 * fewer seats says so. It is a comparison of two rooms, never a fit claim.
 */
export const besideRoom = (capacity: number, own: { name: string; seats: number | null }) =>
  own.seats == null ? "" : capacity < own.seats ? `, fewer than ${own.name}'s ${own.seats}` : capacity === own.seats ? `, the same as ${own.name}` : `, more than ${own.name}'s ${own.seats}`;

export const fitFor = (id: string, capacity: number | null, attendees: number | null | undefined, unreadable = false): RoomFit => {
  if (capacity == null)
    return { id, capacity: null, fit: "not_compared", text: `capacity not compared: ${unreadable ? "its capacity could not be read" : "Zoom gives no capacity for it"}` };
  if (attendees == null) return { id, capacity, fit: "not_compared", text: `seats ${capacity}; capacity not compared: no meeting size given` };
  return capacity >= attendees
    ? { id, capacity, fit: "fits", text: `seats ${capacity}, fits ${people(attendees)}` }
    : { id, capacity, fit: "too_small", text: `seats ${capacity}, too small for ${people(attendees)}` };
};

/** A meeting size the caller gave: a whole number from 1 to MAX_ATTENDEES, else null (not compared). */
export const readAttendees = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_ATTENDEES ? v : null);

/** Each room's seats from its Zoom profile (one read per room, in parallel). A failed read is "could not be read", never a fit. */
export const lookUpFits = (client: { getRoom(id: string): Promise<unknown> }, ids: string[], attendees?: number | null): Promise<RoomFit[]> =>
  Promise.all(
    ids.map(async (id) => {
      try {
        return fitFor(id, readCapacity(await client.getRoom(id)), attendees);
      } catch {
        return fitFor(id, null, attendees, true);
      }
    }),
  );

/** Order for a known meeting size: rooms that fit first, then not compared, then too small (name order kept within each). */
export const FIT_ORDER: Record<Fit, number> = { fits: 0, not_compared: 1, too_small: 2 };
