#!/usr/bin/env node
"use strict";
// DitCopy launcher for macOS, Linux and Windows.
//   node ditcopy.js start [--no-open]   build the engine if needed, start the server in the background, open the page
//   node ditcopy.js stop                stop the background server
//   node ditcopy.js status              say whether it is running
//   node ditcopy.js open                open the page in the browser
// DITCOPY_PORT changes the port. DITCOPY_ENGINE points at an engine program built elsewhere.
// OPEN_BROWSER=0 does not open the page. DITCOPY_NOTIFY_COMMAND names a program that is run with a one line result,
// for example `say` on macOS, if you want to hear when start finishes.
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const platform = require("./server/platform");

const ROOT = __dirname;
const DEFAULT_PORT = 34826; // DITCO on a phone keypad

function parsePort(raw) {
  if (raw == null || raw === "") return DEFAULT_PORT;
  const n = Number(raw);
  if (!/^\d+$/.test(String(raw)) || n < 1 || n > 65535) throw new Error(`DITCOPY_PORT must be a whole number from 1 to 65535, got '${raw}'.`);
  return n;
}

/** The default port keeps the plain file names; other ports get their own so servers do not clash. */
function suffixFor(port) {
  return port === DEFAULT_PORT ? "" : `-${port}`;
}

function enginePath(env = process.env, plat = platform.HERE) {
  return env.DITCOPY_ENGINE || platform.defaultEnginePath(ROOT, plat);
}

function paths(port) {
  const logs = path.join(platform.dataDir(ROOT), "logs");
  const suffix = suffixFor(port);
  return { logs, pid: path.join(logs, `server${suffix}.pid`), log: path.join(logs, `server${suffix}.log`) };
}

function getJson(port, route, timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: route, timeout }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

/** Healthy means this folder's server, with this engine, is answering. */
async function healthy(port, engine) {
  const h = await getJson(port, "/api/health");
  return !!h && h.ok === true && h.engineExists === true && h.engine === engine;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

function withCargoPath(env = process.env) {
  const extra = path.join(os.homedir(), ".cargo", "bin");
  const sep = path.delimiter;
  return { ...env, PATH: [extra, platform.HERE === "darwin" ? "/opt/homebrew/bin:/usr/local/bin" : "", env.PATH || ""].filter(Boolean).join(sep) };
}

function ensureEngine(engine) {
  if (fs.existsSync(engine)) return;
  console.log("Building the DitCopy engine (first run only)...");
  const env = withCargoPath();
  const r = spawnSync("cargo", ["build", "--release", "--locked"], { cwd: path.join(ROOT, "engine"), stdio: "inherit", env, shell: platform.HERE === "win32" });
  if (r.error || r.status !== 0 || !fs.existsSync(engine)) {
    throw new Error("The engine is not built and cargo could not build it. Install Rust from https://rustup.rs, then run this again, or set DITCOPY_ENGINE to a built engine program.");
  }
}

function openPage(url) {
  const cmd = platform.openCommand(url);
  try {
    spawn(cmd.file, cmd.args, { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref();
  } catch {
    /* the page can be opened by hand */
  }
}

function speak(result) {
  const command = process.env.DITCOPY_NOTIFY_COMMAND;
  if (!command) return;
  try {
    spawn(command, [`DitCopy startup finished, ${result}`], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* the notice is optional */
  }
}

async function start(args) {
  const port = parsePort(process.env.DITCOPY_PORT);
  const engine = enginePath();
  const url = `http://127.0.0.1:${port}`;
  const p = paths(port);
  const openIt = process.env.OPEN_BROWSER !== "0" && !args.includes("--no-open");
  try {
    if (!(await healthy(port, engine))) {
      if (await portInUse(port)) throw new Error(`Port ${port} is occupied by another service; cannot start DitCopy. Set DITCOPY_PORT to use another port.`);
      ensureEngine(engine);
      fs.mkdirSync(p.logs, { recursive: true });
      const out = fs.openSync(p.log, "a");
      console.log("Starting DitCopy server...");
      const child = spawn(process.execPath, [path.join(ROOT, "server", "server.js")], {
        cwd: ROOT, detached: true, stdio: ["ignore", out, out], windowsHide: true,
        env: { ...process.env, DITCOPY_PORT: String(port), DITCOPY_ENGINE: engine },
      });
      child.unref();
      fs.writeFileSync(p.pid, String(child.pid));
    }
    for (let i = 0; i < 80; i++) {
      if (await healthy(port, engine)) {
        if (openIt) openPage(url);
        console.log(`DitCopy UI: ${url}`);
        console.log(`Logs: ${p.log}`);
        speak("passed");
        return 0;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    console.error(`Server failed to start. Check ${p.log}`);
    try { console.error(fs.readFileSync(p.log, "utf8").split("\n").slice(-20).join("\n")); } catch { /* no log */ }
    speak("failed");
    return 1;
  } catch (e) {
    console.error(e.message);
    speak("failed");
    return 1;
  }
}

async function stop() {
  const port = parsePort(process.env.DITCOPY_PORT);
  const engine = enginePath();
  const p = paths(port);
  if (!fs.existsSync(p.pid)) { console.log(`No pid file at ${p.pid}, nothing to stop`); return 0; }
  const pid = Number(fs.readFileSync(p.pid, "utf8").trim());
  if (!pid) { console.log("Empty pid file, nothing to stop"); fs.writeFileSync(p.pid, ""); return 0; }
  let alive = true;
  try { process.kill(pid, 0); } catch (e) { alive = e.code === "EPERM"; }
  if (!alive) { console.log(`Process ${pid} not running`); fs.writeFileSync(p.pid, ""); return 0; }
  // Only stop a process that answers as this folder's DitCopy server, never a stranger that reused the number.
  if (!(await healthy(port, engine))) {
    console.log("PID belongs to another process; leaving it alone.");
    fs.writeFileSync(p.pid, "");
    return 0;
  }
  console.log(`Stopping DitCopy server pid ${pid}`);
  try { process.kill(pid); } catch (e) { console.error(`Could not stop it: ${e.message}`); return 1; }
  for (let i = 0; i < 25; i++) {
    if (!(await portInUse(port))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(!(await portInUse(port)) ? "Stopped" : "Process still running; try again");
  fs.writeFileSync(p.pid, "");
  return 0;
}

async function status() {
  const port = parsePort(process.env.DITCOPY_PORT);
  const up = await healthy(port, enginePath());
  console.log(up ? `DitCopy is running at http://127.0.0.1:${port}` : "DitCopy is not running");
  return up ? 0 : 1;
}

async function main(argv) {
  const [cmd = "start", ...rest] = argv;
  if (cmd === "start") return start(rest);
  if (cmd === "stop") return stop();
  if (cmd === "status") return status();
  if (cmd === "open") { openPage(`http://127.0.0.1:${parsePort(process.env.DITCOPY_PORT)}`); return 0; }
  console.error("Usage: node ditcopy.js start|stop|status|open");
  return 2;
}

module.exports = { DEFAULT_PORT, parsePort, suffixFor, enginePath, paths };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e.message); process.exit(1); });
}
