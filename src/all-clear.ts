// Wording shared by get_rooms_needing_attention and diagnose_rooms for an account whose devices all read online but
// whose room profiles carry no alerts (Zoom's documented profile has none; real alerts live on the Dashboard).

/** diagnoseRoom's note for a room profile without an issues list (Zoom's documented profile has none). */
// `issues: null` (an empty value in place of the list) reads the same (Sonnet review, 11/27).
export const NO_ALERTS = /^Open issues: (the room detail has no issues list|Zoom gave an empty value instead of an issues list)/;
export const alertsNote = (n: number) =>
  `${n === 1 ? "1 room" : `${n} rooms`}: Zoom gives no health or alerts for ${n === 1 ? "it" : "them"} in the room list or profile; every device was read and is online, but open alerts were not checked.`;
export const devicesClearLine = (total: number, unread: number) =>
  `${total === 1 ? "The 1 room is" : `All ${total} rooms are`} up and every device Zoom listed is online. Open alerts could not be read for ${unread === total ? (total === 1 ? "it" : "any of them") : `${unread} of them`} (Zoom's room profile does not carry alerts), so this is not a full all-clear: check alerts in the Zoom Rooms dashboard.`;
