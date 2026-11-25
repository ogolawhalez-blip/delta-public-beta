import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { proxy } from "../../proxy";

const origin = "https://gateway.synthetic.invalid";

test("private routes remain denied even with forged privilege cookies", () => {
  for (const path of ["/founder", "/founder-console", "/internal/founder", "/founder-console/anything"]) {
    const result = proxy(new NextRequest(origin + path, {headers: {cookie: "session_token=synthetic; founder_bypass=true; access_token=synthetic"}}));
    assert.equal(result.status, 404);
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});

test("customer route redirect preserves return path without granting identity", () => {
  const result = proxy(new NextRequest(origin + "/dashboard/orders"));
  assert.equal(result.status, 307);
  const location = new URL(result.headers.get("location")!);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("next"), "/dashboard/orders");
});

test("public route remains reachable through route guard", () => {
  const result = proxy(new NextRequest(origin + "/"));
  assert.equal(result.headers.get("x-middleware-next"), "1");
});
