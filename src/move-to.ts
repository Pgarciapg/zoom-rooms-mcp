// "Where can this meeting go?" (2026-11-23). One rule for diagnose_room and get_rooms_needing_attention: other rooms
// with the same Zoom location code that are Available and Healthy in Zoom's room list. Same code only, never a guess
// across floors or buildings (and a code can be a whole building, so callers say "same Zoom location", not a floor).

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : typeof v === "object" ? "" : String(v));
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Most free rooms named; the rest are counted. */
export const MOVE_TO_LIMIT = 3;

/** A room name as shown in a one-line suggestion: no line breaks or control characters, short. */
export const cleanName = (n: string) => n.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 60);

/** Free, healthy rooms in the given location codes, not the room itself, deduped by id, sorted by name. */
export const freeRoomsIn = (rooms: unknown[], self: Set<string>, locations: Set<string>): { id: string; name: string }[] => {
  const seen = new Set<string>();
  return rooms
    .filter(isObj)
    .filter((r) => !!(str(r.id) || str(r.room_id)) && !self.has(str(r.id)) && !self.has(str(r.room_id)))
    .filter((r) => locations.has(str(r.location_id)) && /^available$/i.test(str(r.status)) && /^healthy$/i.test(str(r.health)))
    .map((r) => {
      const id = str(r.id) || str(r.room_id);
      return { id, name: cleanName(str(r.name)) || cleanName(id) || "Unnamed room" };
    })
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    // "Room 2" before "Room 10".
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
};

/** "A", "A and B", "A, B and C". */
const joinNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/**
 * Several meetings displaced at once (2026-11-23): give each a different free room, in the order given (worst room
 * first), so two meetings are never sent to the same room. Each room's list is its own pick first, then free rooms no
 * other meeting was given. A room whose free rooms were all given away gets a note naming them and who they went to,
 * instead of an empty or shared suggestion. Rooms with no candidates at all get no note.
 */
export const allocateMoveTo = (
  wanted: { name: string; candidates: { id: string; name: string }[] }[],
): { moveTo: { id: string; name: string }[]; moveToNote: string | null }[] => {
  const givenTo = new Map<string, string>(); // free room id -> the meeting room it was suggested for
  const picks = wanted.map(({ name, candidates }, i) => {
    // Among the rooms still open, take the one fewest later meetings could use, so a later meeting with a single option
    // is not stranded (A can use R1 or R2, B only R1: A gets R2). Ties keep name order.
    const later = (id: string) => wanted.slice(i + 1).filter((w) => w.candidates.some((c) => c.id === id)).length;
    const pick = candidates.filter((c) => !givenTo.has(c.id)).reduce<{ id: string; name: string } | null>((best, c) => (!best || later(c.id) < later(best.id) ? c : best), null);
    if (pick) givenTo.set(pick.id, cleanName(name) || "another room");
    return pick;
  });
  return wanted.map(({ candidates }, i) => {
    const pick = picks[i];
    if (pick) return { moveTo: [pick, ...candidates.filter((c) => c.id !== pick.id && !givenTo.has(c.id))].slice(0, MOVE_TO_LIMIT), moveToNote: null };
    if (!candidates.length) return { moveTo: [], moveToNote: null };
    const takers = [...new Set(candidates.map((c) => givenTo.get(c.id)!))];
    const shown = candidates.slice(0, MOVE_TO_LIMIT).map((c) => c.name).join(", ") + (candidates.length > MOVE_TO_LIMIT ? `, +${candidates.length - MOVE_TO_LIMIT} more` : "");
    const note = candidates.length === 1
      ? `the only free room in the same Zoom location, ${candidates[0]!.name}, is suggested for ${joinNames(takers)}`
      : `the ${candidates.length} free rooms in the same Zoom location (${shown}) are suggested for ${joinNames(takers)}`;
    return { moveTo: [], moveToNote: note };
  });
};
