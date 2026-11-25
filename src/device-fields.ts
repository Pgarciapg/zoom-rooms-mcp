// Device rows from GET /rooms/{roomId}/devices (11/25, from the 11/24 review): Zoom's documented row names a device
// `device_hostname` and its firmware `device_firmware`; older fixtures and some accounts use `name` and `firmware`.
// Every tool reads them through these two, so a live row is never shown as an unnamed device with no firmware.

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null || typeof v === "object" ? "" : String(v));

export const deviceName = (d: Record<string, unknown>): string => str(d.name) || str(d.device_hostname);
export const deviceFirmware = (d: Record<string, unknown>): string => str(d.firmware) || str(d.device_firmware);
