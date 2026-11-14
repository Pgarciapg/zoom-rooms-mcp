export interface ZoomCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

interface ZoomTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export const TOKEN_URL = "https://zoom.us/oauth/token";

// One cache entry per Zoom app + account, so one tenant never receives another tenant's token.
// The secret is part of the key, so rotated or different credentials never reuse an old token.
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const cacheKey = (creds: ZoomCredentials) => `${creds.accountId}\u0000${creds.clientId}\u0000${creds.clientSecret}`;

/** Server-to-Server OAuth token for one Zoom account, cached until 100s before it expires. */
export async function getAccessToken(creds: ZoomCredentials): Promise<string> {
  const now = Date.now();
  const key = cacheKey(creds);
  const hit = tokenCache.get(key);
  if (hit && now < hit.expiresAt) return hit.token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${creds.clientId}:${creds.clientSecret}`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `grant_type=account_credentials&account_id=${encodeURIComponent(creds.accountId)}`,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Zoom OAuth token request failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as ZoomTokenResponse;
  // Tokens last 3600s; refresh at 3500s.
  tokenCache.set(key, { token: data.access_token, expiresAt: now + 3500 * 1000 });
  return data.access_token;
}
