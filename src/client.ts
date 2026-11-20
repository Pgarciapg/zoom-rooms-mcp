import { getAccessToken, type ZoomCredentials } from "./auth.ts";
import { MOCK_ROOM_DETAILS, MOCK_ROOM_DEVICES, MOCK_ROOMS } from "./demo-data.ts";

/** The read-only Zoom Rooms calls the MCP tools need. */
export interface ZoomRoomsClient {
  listRooms(): Promise<unknown>;
  getRoom(roomId: string): Promise<unknown>;
  getRoomDevices(roomId: string): Promise<unknown>;
}

export const DEFAULT_BASE_URL = "https://api.zoom.us/v2";
/** Rooms per page (Zoom's maximum) and the most pages read in one call: 50 x 300 = 15,000 rooms. */
export const ROOM_PAGE_SIZE = 300;
export const MAX_ROOM_PAGES = 50;

export class ZoomApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ZoomApiError";
    this.status = status;
  }
}

/** Calls the live Zoom API with Server-to-Server OAuth credentials. */
export class HttpZoomRoomsClient implements ZoomRoomsClient {
  private readonly creds: ZoomCredentials;
  private readonly baseUrl: string;

  constructor(creds: ZoomCredentials, baseUrl = DEFAULT_BASE_URL) {
    this.creds = creds;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(path: string): Promise<unknown> {
    const token = await getAccessToken(this.creds);
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ZoomApiError(res.status, `Zoom API ${res.status} on ${path}: ${body}`);
    }
    return res.json();
  }

  /**
   * Every room, across all pages. Zoom pages the room list (page_size up to 300, then next_page_token). A page that
   * fails throws, so callers never get a partial list presented as complete. If the page cap is hit, the result keeps
   * Zoom's next_page_token, so callers can see the list is not whole.
   */
  async listRooms() {
    const rooms: unknown[] = [];
    const seen = new Set<string>();
    let token = "";
    let last: any = {};
    for (let page = 1; page <= MAX_ROOM_PAGES; page++) {
      const query = `page_size=${ROOM_PAGE_SIZE}${token ? `&next_page_token=${encodeURIComponent(token)}` : ""}`;
      last = await this.request(`/rooms?${query}`);
      const batch = (last as any)?.rooms;
      if (batch != null && !Array.isArray(batch)) throw new ZoomApiError(502, `Zoom returned page ${page} of the room list in an unexpected shape.`);
      rooms.push(...(batch ?? []));
      token = typeof (last as any)?.next_page_token === "string" ? (last as any).next_page_token : "";
      if (!token) return { ...last, rooms, page_count: page, next_page_token: "" };
      if (seen.has(token)) throw new ZoomApiError(502, `Zoom repeated a page token on page ${page} of the room list; stopped so rooms are not counted twice.`);
      seen.add(token);
    }
    return { ...last, rooms, page_count: MAX_ROOM_PAGES, next_page_token: token };
  }

  getRoom(roomId: string) {
    return this.request(`/rooms/${encodeURIComponent(roomId)}`);
  }

  getRoomDevices(roomId: string) {
    return this.request(`/rooms/${encodeURIComponent(roomId)}/devices`);
  }
}

type DemoRoom = (typeof MOCK_ROOMS.rooms)[number];

/** A fictional 32-room campus, so the server can be tried without a Zoom account. */
export class DemoZoomRoomsClient implements ZoomRoomsClient {
  private find(roomId: string): DemoRoom {
    const room = MOCK_ROOMS.rooms.find((r) => r.id === roomId || r.room_id === roomId);
    if (!room) throw new ZoomApiError(404, `Room not found: ${roomId}. Call list_zoom_rooms for valid ids.`);
    return room;
  }

  async listRooms() {
    return MOCK_ROOMS;
  }

  async getRoom(roomId: string) {
    const room = this.find(roomId);
    return (
      MOCK_ROOM_DETAILS[room.id] ?? {
        ...room,
        issues: [],
      }
    );
  }

  async getRoomDevices(roomId: string) {
    const room = this.find(roomId);
    return (
      MOCK_ROOM_DEVICES[room.id] ?? {
        devices: [
          { id: `${room.id}-ctrl`, device_type: "Controller", name: "Zoom Rooms Controller", status: "Online", firmware: "5.17.0" },
          { id: `${room.id}-disp`, device_type: "Display", name: "Display", status: room.status === "Offline" ? "Offline" : "Online", firmware: "1.0" },
        ],
      }
    );
  }
}
