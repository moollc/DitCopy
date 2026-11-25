#!/usr/bin/env node
"use strict";
// Proves a packaged copy works: starts it, copies a small folder through the real engine to a second folder, verifies
// every byte, stops it. Used by the release workflow on every system.
//   node scripts/smoke.js <bundleDir>
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const bundle = path.resolve(process.argv[2] || ".");
const win = process.platform === "win32";
const nodeBin = path.join(bundle, "runtime", win ? "node.exe" : "node");
if (!fs.existsSync(nodeBin)) {
  console.error("SMOKE TEST FAILED: the packaged copy has no runtime/node, so it would need Node installed");
  process.exit(1);
}

/**
 * An environment like a clean machine: only the system's own program folders on PATH, an empty home folder, none of the
 * developer variables. A package that passes here does not lean on anything installed on the machine that built it.
 */
function cleanEnv(home) {
  const keep = ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const sys = win ? [`${process.env.SystemRoot || "C:\\Windows"}\\System32`, process.env.SystemRoot || "C:\\Windows", `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0`] : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  env.PATH = sys.join(path.delimiter);
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.XDG_DATA_HOME = path.join(home, ".local", "share");
  return env;
}

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

function request(port, method, route, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {} }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { try { resolve({ status: res.statusCode, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-smoke-"));
  const src = path.join(work, "card");
  const dest = path.join(work, "backup");
  fs.mkdirSync(path.join(src, "CLIP", "nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "a.txt"), "camera data\n");
  fs.writeFileSync(path.join(src, "CLIP", "one.mxf"), crypto.randomBytes(3 * 1024 * 1024));
  fs.writeFileSync(path.join(src, "CLIP", "nested", "two.mxf"), crypto.randomBytes(1024 * 1024 + 17));
  const port = await freePort();
  const home = path.join(work, "home");
  fs.mkdirSync(home, { recursive: true });
  const env = { ...cleanEnv(home), DITCOPY_PORT: String(port), OPEN_BROWSER: "0" };
  const run = (cmd) => spawnSync(nodeBin, [path.join(bundle, "ditcopy.js"), cmd], { env, cwd: bundle, encoding: "utf8", timeout: 90000 });
  let failure = null;
  try {
    const started = run("start");
    if (started.status !== 0) throw new Error(`start failed: ${started.stdout}${started.stderr}`);
    const health = (await request(port, "GET", "/api/health")).json;
    if (!health || !health.engineExists) throw new Error("the engine was not found in the packaged copy");
    const page = await request(port, "GET", "/");
    if (page.status !== 200) throw new Error(`the page did not load (${page.status})`);
    const job = await request(port, "POST", "/api/jobs", { src: [src], dest: [dest], mode: "force", hash: "xxh3", verify: true, jobName: "smoke" });
    if (job.status >= 300 || !job.json?.id) throw new Error(`the job was refused: ${JSON.stringify(job.json)}`);
    let state = null;
    for (let i = 0; i < 240; i++) {
      state = (await request(port, "GET", `/api/jobs/${job.json.id}`)).json;
      if (state && !["running", "queued", "pausing", "stopping"].includes(state.status)) break;
      await sleep(500);
    }
    if (!state || state.status !== "done") throw new Error(`the job ended as ${state && state.status}: ${JSON.stringify(state && (state.error || state.summary))}`);
    if ((state.summary?.errors ?? 1) !== 0) throw new Error(`the job reported errors: ${JSON.stringify(state.summary)}`);
    const copied = path.join(dest, "card");
    const files = walk(src).map((f) => path.relative(src, f));
    for (const rel of files) {
      const a = path.join(src, rel);
      const b = path.join(copied, rel);
      if (!fs.existsSync(b)) throw new Error(`missing in the copy: ${rel}`);
      if (hashOf(a) !== hashOf(b)) throw new Error(`the copy differs: ${rel}`);
    }
    // A packaged copy keeps its logs in the user's data folder, never inside its own (possibly read only) folder.
    const wrote = walk(home).length;
    if (wrote === 0) throw new Error("the packaged copy wrote no logs to the user data folder, so it is writing somewhere else");
    console.log(`smoke test passed on ${process.platform} with a clean environment: ${files.length} files copied and checked byte for byte through ${path.basename(nodeBin)} and the packaged engine`);
  } catch (e) {
    failure = e;
  } finally {
    run("stop");
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (failure) { console.error(`SMOKE TEST FAILED: ${failure.message}`); process.exit(1); }
}

main();
