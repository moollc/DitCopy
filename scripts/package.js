#!/usr/bin/env node
"use strict";
// Builds a self contained copy of DitCopy that needs nothing installed: the server, the page, the engine and a Node runtime.
//   node scripts/package.js <outDir> [--engine <path>] [--node <path>] [--version <text>]
// The engine defaults to the one built here (cargo build --release), the Node runtime to the one running this script.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const platform = require("../server/platform");

const ROOT = path.join(__dirname, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const notTest = (src) => !src.endsWith(".test.js");

const firstWords = {
  darwin: "Double click start.command. If macOS says it cannot verify the developer, right click the file, choose Open, then Open.",
  linux: "Open a terminal in this folder and run ./start.sh",
  win32: "Double click start.bat. If Windows SmartScreen appears, choose More info, then Run anyway.",
};

function main() {
  const out = process.argv[2];
  if (!out || out.startsWith("--")) {
    console.error("Usage: node scripts/package.js <outDir> [--engine <path>] [--node <path>] [--version <text>]");
    process.exit(2);
  }
  const plat = platform.HERE;
  const engine = arg("--engine", platform.defaultEnginePath(ROOT));
  const nodeBin = arg("--node", process.execPath);
  const version = arg("--version", "dev");
  if (!fs.existsSync(engine)) throw new Error(`The engine is not built: ${engine}. Run cargo build --release in engine/ first.`);
  // Some package managers (Homebrew) install Node as a small launcher that needs a separate library. A copy made from it
  // fails on any other machine with "Library not loaded". The official Node from nodejs.org is one large file.
  const nodeSize = fs.statSync(nodeBin).size;
  if (nodeSize < 20 * 1024 * 1024) throw new Error(`${nodeBin} is only ${Math.round(nodeSize / 1024)} KB, a launcher that is not self contained. Use the official Node from https://nodejs.org (pass it with --node).`);
  fs.mkdirSync(out, { recursive: true });

  for (const f of ["ditcopy.js", "start.command", "stop.command", "start.sh", "stop.sh", "start.bat", "stop.bat", "LICENSE", "README.md"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  }
  for (const d of ["server", "ui", "presets"]) fs.cpSync(path.join(ROOT, d), path.join(out, d), { recursive: true, filter: notTest });

  fs.mkdirSync(path.join(out, "engine"), { recursive: true });
  fs.copyFileSync(engine, path.join(out, "engine", platform.engineFileName(plat)));
  fs.mkdirSync(path.join(out, "runtime"), { recursive: true });
  fs.copyFileSync(nodeBin, path.join(out, "runtime", plat === "win32" ? "node.exe" : "node"));

  for (const f of ["start.command", "stop.command", "start.sh", "stop.sh", path.join("engine", platform.engineFileName(plat)), path.join("runtime", plat === "win32" ? "node.exe" : "node")]) {
    fs.chmodSync(path.join(out, f), 0o755);
  }
  fs.writeFileSync(path.join(out, "bundle.json"), JSON.stringify({ name: "DitCopy", version, platform: plat, arch: os.arch(), built: new Date().toISOString() }, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "README-FIRST.txt"),
    `DitCopy ${version} for ${plat} ${os.arch()}\n\n${firstWords[plat] || firstWords.linux}\n\n` +
    "It opens a page in your browser at http://127.0.0.1:34826. Nothing else needs to be installed.\n" +
    "Stop it with stop.command, stop.sh or stop.bat. Logs and saved jobs are kept in your user data folder.\n" +
    "Source and license: https://github.com/moollc/DitCopy\n");
  console.log(`Packaged DitCopy ${version} (${plat} ${os.arch()}) in ${out}`);
}

module.exports = { notTest };
if (require.main === module) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
