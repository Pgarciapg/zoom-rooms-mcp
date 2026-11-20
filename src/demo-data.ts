// Realistic mock data for demo/testing without a Zoom Rooms subscription

export const MOCK_ROOMS = {
  page_count: 1,
  page_number: 1,
  page_size: 30,
  total_records: 32,
  rooms: [
    { id: "rm-001", name: "Conference 4B", room_id: "conf-4b", status: "Offline", health: "Critical", location_id: "bldg-1-floor-4" },
    { id: "rm-002", name: "Boardroom East", room_id: "board-east", status: "Available", health: "Warning", location_id: "bldg-1-floor-2" },
    { id: "rm-003", name: "Room 212", room_id: "room-212", status: "Available", health: "Warning", location_id: "bldg-1-floor-2" },
    { id: "rm-004", name: "Huddle A", room_id: "huddle-a", status: "Available", health: "Healthy", location_id: "bldg-1-floor-1" },
    { id: "rm-005", name: "Huddle B", room_id: "huddle-b", status: "In Meeting", health: "Healthy", location_id: "bldg-1-floor-1" },
    { id: "rm-006", name: "Executive Suite", room_id: "exec-suite", status: "Available", health: "Healthy", location_id: "bldg-1-floor-5" },
    { id: "rm-007", name: "Training Room 1", room_id: "train-1", status: "In Meeting", health: "Healthy", location_id: "bldg-2-floor-1" },
    { id: "rm-008", name: "Training Room 2", room_id: "train-2", status: "Available", health: "Healthy", location_id: "bldg-2-floor-1" },
    { id: "rm-009", name: "All Hands", room_id: "all-hands", status: "Available", health: "Healthy", location_id: "bldg-1-floor-1" },
    { id: "rm-010", name: "Boardroom West", room_id: "board-west", status: "Available", health: "Healthy", location_id: "bldg-1-floor-2" },
    { id: "rm-011", name: "Room 301", room_id: "room-301", status: "Available", health: "Healthy", location_id: "bldg-1-floor-3" },
    { id: "rm-012", name: "Room 302", room_id: "room-302", status: "In Meeting", health: "Healthy", location_id: "bldg-1-floor-3" },
    { id: "rm-013", name: "Room 303", room_id: "room-303", status: "Available", health: "Healthy", location_id: "bldg-1-floor-3" },
    { id: "rm-014", name: "Room 304", room_id: "room-304", status: "Available", health: "Healthy", location_id: "bldg-1-floor-3" },
    { id: "rm-015", name: "Café Meeting", room_id: "cafe-mtg", status: "Available", health: "Healthy", location_id: "bldg-1-floor-1" },
    { id: "rm-016", name: "Room 401", room_id: "room-401", status: "Available", health: "Healthy", location_id: "bldg-1-floor-4" },
    { id: "rm-017", name: "Room 402", room_id: "room-402", status: "Available", health: "Healthy", location_id: "bldg-1-floor-4" },
    { id: "rm-018", name: "Room 403", room_id: "room-403", status: "In Meeting", health: "Healthy", location_id: "bldg-1-floor-4" },
    { id: "rm-019", name: "Room 501", room_id: "room-501", status: "Available", health: "Healthy", location_id: "bldg-1-floor-5" },
    { id: "rm-020", name: "Room 502", room_id: "room-502", status: "Available", health: "Healthy", location_id: "bldg-1-floor-5" },
    { id: "rm-021", name: "Lab A", room_id: "lab-a", status: "Available", health: "Healthy", location_id: "bldg-2-floor-2" },
    { id: "rm-022", name: "Lab B", room_id: "lab-b", status: "Available", health: "Healthy", location_id: "bldg-2-floor-2" },
    { id: "rm-023", name: "Bldg 2 Conf 1", room_id: "b2-conf-1", status: "Available", health: "Healthy", location_id: "bldg-2-floor-1" },
    { id: "rm-024", name: "Bldg 2 Conf 2", room_id: "b2-conf-2", status: "In Meeting", health: "Healthy", location_id: "bldg-2-floor-1" },
    { id: "rm-025", name: "Bldg 2 Huddle", room_id: "b2-huddle", status: "Available", health: "Healthy", location_id: "bldg-2-floor-1" },
    { id: "rm-026", name: "Bldg 3 Main", room_id: "b3-main", status: "Available", health: "Healthy", location_id: "bldg-3-floor-1" },
    { id: "rm-027", name: "Bldg 3 Conf A", room_id: "b3-conf-a", status: "Available", health: "Healthy", location_id: "bldg-3-floor-1" },
    { id: "rm-028", name: "Bldg 3 Conf B", room_id: "b3-conf-b", status: "Available", health: "Healthy", location_id: "bldg-3-floor-1" },
    { id: "rm-029", name: "Bldg 3 Huddle", room_id: "b3-huddle", status: "Available", health: "Healthy", location_id: "bldg-3-floor-1" },
    { id: "rm-030", name: "Outdoor Pavilion", room_id: "outdoor-pav", status: "Available", health: "Healthy", location_id: "campus-outdoor" },
    { id: "rm-031", name: "Reception Desk", room_id: "reception", status: "Available", health: "Healthy", location_id: "bldg-1-floor-1" },
    { id: "rm-032", name: "Security Office", room_id: "security", status: "Available", health: "Healthy", location_id: "bldg-1-floor-1" },
  ],
};

export const MOCK_ROOM_DETAILS: Record<string, unknown> = {
  "rm-001": {
    id: "rm-001", name: "Conference 4B", room_id: "conf-4b", status: "Offline",
    health: "Critical", location: { building: "Building 1", floor: "4th Floor" },
    issues: [{ issue: "USB camera disconnected", severity: "critical", since: "2026-03-28T09:22:00Z" }],
    device_ip: "10.10.4.120", last_online: "2026-03-28T09:20:00Z",
  },
  "rm-002": {
    id: "rm-002", name: "Boardroom East", room_id: "board-east", status: "Available",
    health: "Warning", location: { building: "Building 1", floor: "2nd Floor" },
    issues: [{ issue: "Microphone offline", severity: "warning", since: "2026-03-28T08:40:00Z" }],
    device_ip: "10.10.2.105", last_online: "2026-03-28T16:00:00Z",
  },
  "rm-003": {
    id: "rm-003", name: "Room 212", room_id: "room-212", status: "Available",
    health: "Warning", location: { building: "Building 1", floor: "2nd Floor" },
    issues: [{ issue: "Controller high CPU (92%)", severity: "warning", since: "2026-03-28T08:15:00Z" }],
    device_ip: "10.10.2.112", last_online: "2026-03-28T16:00:00Z",
  },
};

export const MOCK_ROOM_DEVICES: Record<string, unknown> = {
  "rm-001": {
    devices: [
      { id: "dev-001", device_type: "Camera", name: "Logitech Rally", status: "Disconnected", firmware: "1.8.230" },
      { id: "dev-002", device_type: "Speaker", name: "Rally Speaker", status: "Online", firmware: "1.8.230" },
      { id: "dev-003", device_type: "Controller", name: "Zoom Rooms Controller", status: "Online", firmware: "5.17.0" },
      { id: "dev-004", device_type: "Display", name: "Samsung 65\" QM65R", status: "Online", firmware: "1230.4" },
    ],
  },
  "rm-002": {
    devices: [
      { id: "dev-005", device_type: "Camera", name: "Poly Studio X50", status: "Online", firmware: "4.1.0" },
      { id: "dev-006", device_type: "Microphone", name: "Shure MXA920", status: "Offline", firmware: "4.6.12" },
      { id: "dev-007", device_type: "Controller", name: "Zoom Rooms Controller", status: "Online", firmware: "5.17.0" },
      { id: "dev-008", device_type: "Display", name: "LG 75\" 75UN8570", status: "Online", firmware: "03.30.70" },
    ],
  },
};


/** The same campus a day earlier, used only as demo mode's saved previous check: Conference 4B and Room 212 were fine,
 * and Room 401 had a display down that has since come back. */
export const EARLIER_ROOMS = {
  ...MOCK_ROOMS,
  rooms: MOCK_ROOMS.rooms.map((r) =>
    r.id === "rm-001" ? { ...r, status: "Available", health: "Healthy" }
    : r.id === "rm-003" ? { ...r, health: "Healthy" }
    : r.id === "rm-016" ? { ...r, health: "Warning" }
    : r),
};
export const EARLIER_DETAILS: Record<string, unknown> = {
  "rm-002": MOCK_ROOM_DETAILS["rm-002"],
  "rm-016": { id: "rm-016", name: "Room 401", status: "Available", health: "Warning", issues: [{ issue: "Display disconnected", severity: "warning", since: "2026-03-27T15:00:00Z" }] },
};
export const EARLIER_DEVICES: Record<string, unknown> = {
  "rm-002": MOCK_ROOM_DEVICES["rm-002"],
  "rm-016": { devices: [
    { id: "rm-016-ctrl", device_type: "Controller", name: "Zoom Rooms Controller", status: "Online", firmware: "5.17.0" },
    { id: "rm-016-disp", device_type: "Display", name: "Display", status: "Offline", firmware: "1.0" },
  ] },
};
