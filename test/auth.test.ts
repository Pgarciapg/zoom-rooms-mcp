// Regression tests for the per-account Zoom token cache (carried over from AV Flow, fix 1ce5054).
// Before that fix, getAccessToken() kept one server-wide token, so user B could
// receive user A's Zoom token on a warm instance. These tests fail if that returns.
// No network: fetch is mocked.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getAccessToken, type ZoomCredentials } from "../src/auth.ts";

const realFetch = globalThis.fetch;
const realNow = Date.now;
type Call = { url: string; clientId: string; clientSecret: string; accountId: string | null; body: string };
let calls: Call[] = [];
let issued = 0;

// Fake Zoom token endpoint: issues a token that names the account and client it was issued for.
function mockZoom() {
  calls = [];
  issued = 0;
  globalThis.fetch = (async (url: string | URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    const [clientId = "", clientSecret = ""] = atob(headers.Authorization!.replace("Basic ", "")).split(":");
    const accountId = new URLSearchParams(body).get("account_id");
    calls.push({ url: String(url), clientId, clientSecret, accountId, body });
    issued += 1;
    return new Response(
      JSON.stringify({ access_token: `tok:${accountId}:${clientId}:${issued}`, token_type: "bearer", expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
}

// The cache is module-level and lives for the whole file, so every test uses its own unique credentials.
let seq = 0;
const creds = (label: string, overrides: Partial<ZoomCredentials> = {}): ZoomCredentials => {
  seq += 1;
  return { accountId: `acct-${label}-${seq}`, clientId: `client-${label}-${seq}`, clientSecret: `secret-${label}-${seq}`, ...overrides };
};

beforeEach(() => mockZoom());
afterEach(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
});

test("two Zoom accounts each get only their own token", async () => {
  const a = creds("a");
  const b = creds("b");

  const tokA = await getAccessToken(a);
  const tokB = await getAccessToken(b);

  assert.notEqual(tokB, tokA, "account B must never receive account A's token");
  assert.equal(tokA, `tok:${a.accountId}:${a.clientId}:1`);
  assert.equal(tokB, `tok:${b.accountId}:${b.clientId}:2`);
  assert.equal(calls.length, 2, "each account needs its own token request");
  assert.deepEqual(
    calls.map((c) => [c.accountId, c.clientId, c.clientSecret]),
    [
      [a.accountId, a.clientId, a.clientSecret],
      [b.accountId, b.clientId, b.clientSecret],
    ],
  );
  assert.ok(calls.every((c) => c.url === "https://zoom.us/oauth/token"));
});

test("interleaved repeat calls hit the cache and stay per account", async () => {
  const a = creds("a");
  const b = creds("b");

  const tokA = await getAccessToken(a);
  const tokB = await getAccessToken(b);
  assert.equal(await getAccessToken(a), tokA);
  assert.equal(await getAccessToken(b), tokB);
  assert.equal(await getAccessToken(a), tokA);
  assert.equal(calls.length, 2, "repeat calls must be served from the cache");
});

test("same account with a different client or rotated secret does not reuse the old token", async () => {
  const a = creds("a");
  const tok = await getAccessToken(a);

  const otherClient = await getAccessToken({ ...a, clientId: `${a.clientId}-other` });
  const rotated = await getAccessToken({ ...a, clientSecret: `${a.clientSecret}-rotated` });

  assert.notEqual(otherClient, tok);
  assert.notEqual(rotated, tok);
  assert.notEqual(rotated, otherClient);
  assert.equal(calls.length, 3);
});

test("a cached token is refreshed once it is past its 3500s lifetime", async () => {
  const a = creds("a");
  const start = realNow();
  Date.now = () => start;
  const first = await getAccessToken(a);

  Date.now = () => start + 3499 * 1000;
  assert.equal(await getAccessToken(a), first, "still cached just before expiry");

  Date.now = () => start + 3501 * 1000;
  const second = await getAccessToken(a);
  assert.notEqual(second, first, "must fetch a fresh token after expiry");
  assert.equal(calls.length, 2);
});

test("account id is URL-encoded in the token request body", async () => {
  const a = creds("a", { accountId: "acct&grant_type=client_credentials" });
  await getAccessToken(a);
  assert.equal(calls[0]!.accountId, a.accountId);
  assert.equal(calls[0]!.body, `grant_type=account_credentials&account_id=${encodeURIComponent(a.accountId)}`);
});

test("a failed token request throws and caches nothing", async () => {
  const a = creds("a");
  globalThis.fetch = (async () => new Response("invalid_client", { status: 401 })) as typeof fetch;
  await assert.rejects(getAccessToken(a), /Zoom OAuth token request failed \(401\): invalid_client/);

  mockZoom();
  const tok = await getAccessToken(a);
  assert.match(tok, /^tok:/);
  assert.equal(calls.length, 1);
});
