"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { checkRequest } = require("./host-guard");

const req = (method, headers) => ({ method, headers });

test("local host passes", () => {
  assert.strictEqual(checkRequest(req("GET", { host: "127.0.0.1:8788" }), 8788), null);
  assert.strictEqual(checkRequest(req("POST", { host: "localhost:8788", origin: "http://localhost:8788" }), 8788), null);
});
test("rebinding host is refused", () => {
  assert.strictEqual(checkRequest(req("GET", { host: "evil.example:8788" }), 8788), "bad host");
  assert.strictEqual(checkRequest(req("GET", {}), 8788), "bad host");
});
test("foreign origin on a write is refused, a read is not checked", () => {
  assert.strictEqual(checkRequest(req("POST", { host: "127.0.0.1:8788", origin: "https://evil.example" }), 8788), "bad origin");
  assert.strictEqual(checkRequest(req("GET", { host: "127.0.0.1:8788", origin: "https://evil.example" }), 8788), null);
});
test("no origin is allowed for tools", () => {
  assert.strictEqual(checkRequest(req("POST", { host: "127.0.0.1:8788" }), 8788), null);
});
