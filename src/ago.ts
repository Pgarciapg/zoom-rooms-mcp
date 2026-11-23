// How long ago, in one rule for diagnose_room and get_rooms_needing_attention (moved here 2026-11-23 so both use it).

/** "about 3 h" / "about 4 days", or null when the time is missing, unreadable or in the future. */
export const ago = (iso: string | null, now: number): string | null => {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at > now) return null;
  const hours = (now - at) / 3_600_000;
  if (hours < 1) return "under an hour";
  if (hours < 48) return `about ${Math.round(hours)} h`;
  return `about ${Math.round(hours / 24).toLocaleString("en-US")} days`;
};
