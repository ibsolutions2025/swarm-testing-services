import test from "node:test";
import assert from "node:assert/strict";
import {
  assertPublicTargetUrl,
  isPublicIpAddress,
  parseTargetUrl
} from "../lib/target-url.mjs";

test("blocks local, private, reserved, credentialed, and custom-port targets", () => {
  const blocked = [
    "http://localhost",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://192.168.1.10",
    "http://user:pass@example.com",
    "https://example.com:3000"
  ];
  for (const url of blocked) assert.throws(() => parseTargetUrl(url), { name: "TargetUrlError" });
});

test("recognizes public and non-public IP addresses", () => {
  assert.equal(isPublicIpAddress("8.8.8.8"), true);
  assert.equal(isPublicIpAddress("203.0.113.10"), false);
  assert.equal(isPublicIpAddress("::1"), false);
  assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);
  assert.equal(isPublicIpAddress("2606:4700:4700::1111"), true);
});

test("revalidates DNS and rejects any private resolution", async () => {
  await assert.rejects(
    () => assertPublicTargetUrl("https://example.com", {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]
    }),
    { name: "TargetUrlError" }
  );
});

test("accepts a public https target", async () => {
  const result = await assertPublicTargetUrl("https://example.com/docs#start", {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }]
  });
  assert.equal(result.url.toString(), "https://example.com/docs");
});
