import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCredentials, parseEnvFile } from "../src/credentials.ts";

const noFile = () => {
  throw new Error("should not read a file");
};

test("no credentials means undefined (demo mode)", () => {
  assert.equal(loadCredentials({}, noFile), undefined);
});

test("reads all three from the environment", () => {
  assert.deepEqual(loadCredentials({ ZOOM_ACCOUNT_ID: " acct ", ZOOM_CLIENT_ID: "cid", ZOOM_CLIENT_SECRET: "sec" }, noFile), {
    accountId: "acct",
    clientId: "cid",
    clientSecret: "sec",
  });
});

test("partial credentials throw and name what is missing", () => {
  assert.throws(() => loadCredentials({ ZOOM_ACCOUNT_ID: "acct" }, noFile), /missing ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET/);
});

test("falls back to ZOOM_CREDENTIALS_FILE, environment wins", () => {
  const file = '# zoom\nexport ZOOM_ACCOUNT_ID="file-acct"\nZOOM_CLIENT_ID=file-cid\nZOOM_CLIENT_SECRET=\'file-sec\'\n';
  const creds = loadCredentials({ ZOOM_CREDENTIALS_FILE: "/x/.env", ZOOM_CLIENT_ID: "env-cid" }, (p) => {
    assert.equal(p, "/x/.env");
    return file;
  });
  assert.deepEqual(creds, { accountId: "file-acct", clientId: "env-cid", clientSecret: "file-sec" });
});

test("parseEnvFile keeps = inside values", () => {
  assert.deepEqual(parseEnvFile("A=b=c\n\n#x=y\nnoequals"), { A: "b=c" });
});
