import { readFileSync } from "node:fs";
import type { ZoomCredentials } from "./auth.ts";

export const ENV_NAMES = { accountId: "ZOOM_ACCOUNT_ID", clientId: "ZOOM_CLIENT_ID", clientSecret: "ZOOM_CLIENT_SECRET" } as const;

const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");

/** Parses dotenv-style NAME=value lines; blank lines and # comments are skipped. */
export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const name = line.slice(0, line.indexOf("=")).replace(/^export\s+/, "").trim();
    out[name] = unquote(line.slice(line.indexOf("=") + 1));
  }
  return out;
};

/**
 * Reads Server-to-Server OAuth credentials from ZOOM_ACCOUNT_ID / ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET,
 * falling back to a dotenv file named by ZOOM_CREDENTIALS_FILE. Environment values win.
 * Returns undefined when none are set; throws when only some are, so a typo never silently means demo mode.
 */
export const loadCredentials = (env: NodeJS.ProcessEnv = process.env, readFile = (path: string) => readFileSync(path, "utf8")): ZoomCredentials | undefined => {
  const file = env.ZOOM_CREDENTIALS_FILE ? parseEnvFile(readFile(env.ZOOM_CREDENTIALS_FILE)) : {};
  const pick = (name: string) => (env[name]?.trim() || file[name] || "").trim();
  const creds = {
    accountId: pick(ENV_NAMES.accountId),
    clientId: pick(ENV_NAMES.clientId),
    clientSecret: pick(ENV_NAMES.clientSecret),
  };
  const missing = (Object.keys(ENV_NAMES) as (keyof typeof ENV_NAMES)[]).filter((k) => !creds[k]).map((k) => ENV_NAMES[k]);
  if (missing.length === 3) return undefined;
  if (missing.length) throw new Error(`Incomplete Zoom credentials: missing ${missing.join(", ")}.`);
  return creds;
};
