"use strict";
// Run: node --test server/port-defaults.test.js
// The default port is written in four places (server, MCP tools, native app, launcher).
// This keeps them equal, so one cannot be changed without the others.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const pick = (text, re, label) => { const m = text.match(re); assert.ok(m, "no default port found in " + label); return Number(m[1]); };

test("every place that names the default port agrees, and it is the DITCO number", () => {
  const found = {
    server: pick(read("server/server.js"), /const DEFAULT_PORT = (\d+);/, "server.js"),
    mcp: pick(read("mcp/server.js"), /DITCOPY_PORT \|\| (\d+)/, "mcp/server.js"),
    app: pick(read("app/main.swift"), /\["DITCOPY_PORT"\] \?\? "(\d+)"/, "main.swift"),
    launcher: pick(read("ditcopy.js"), /const DEFAULT_PORT = (\d+);/, "ditcopy.js"),
  };
  for (const [k, v] of Object.entries(found)) assert.strictEqual(v, 34826, k + " default port");
});

test("34826 spells DITCO on a phone keypad", () => {
  const keys = { ABC: 2, DEF: 3, GHI: 4, JKL: 5, MNO: 6, PQRS: 7, TUV: 8, WXYZ: 9 };
  const digit = (c) => Object.entries(keys).find(([letters]) => letters.includes(c))[1];
  assert.strictEqual([..."DITCO"].map(digit).join(""), "34826");
});
