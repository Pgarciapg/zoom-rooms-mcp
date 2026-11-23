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
