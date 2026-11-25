"use strict";
// Run: node --test server/system-files.test.js
// End to end with the real engine: system files are skipped by default and copied when the person turns the option off.
// Skipped when the engine has not been built (cargo build --release in engine/).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const platform = require("./platform");

const ROOT = path.join(__dirname, "..");
const engine = platform.defaultEnginePath(ROOT);
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function copy(port, src, dest, extra) {
  const job = await request(port, "POST", "/api/jobs", { src: [src], dest: [dest], mode: "force", hash: "xxh3", verify: true, ...extra });
  assert.ok(job.json && job.json.id, JSON.stringify(job.json));
  let state;
  for (let i = 0; i < 120; i++) {
    state = (await request(port, "GET", `/api/jobs/${job.json.id}`)).json;
    if (state && !["running", "queued", "pausing", "stopping"].includes(state.status)) break;
    await sleep(250);
  }
  assert.equal(state.status, "done", JSON.stringify(state.error || state.summary));
  return state;
}

const names = (dir) => fs.readdirSync(dir, { recursive: true }).map((p) => String(p).split(path.sep).join("/")).sort();

test("system files are skipped by default and copied when the option is off", { skip: !fs.existsSync(engine) && "the engine is not built" }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-junk-"));
  const port = await freePort();
  const env = { ...process.env, DITCOPY_PORT: String(port), DITCOPY_DATA: path.join(work, "data"), DITCOPY_ENGINE: engine, OPEN_BROWSER: "0" };
  const run = (cmd) => spawnSync(process.execPath, [path.join(ROOT, "ditcopy.js"), cmd], { env, encoding: "utf8", timeout: 60000 });
  try {
    const src = path.join(work, "card");
    fs.mkdirSync(path.join(src, "CLIP"), { recursive: true });
    fs.mkdirSync(path.join(src, ".Spotlight-V100"));
    fs.mkdirSync(path.join(src, ".Trashes"));
    fs.writeFileSync(path.join(src, "CLIP", "one.mxf"), "video");
    fs.writeFileSync(path.join(src, "CLIP", "._one.mxf"), "apple double");
    fs.writeFileSync(path.join(src, ".DS_Store"), "x");
    fs.writeFileSync(path.join(src, ".Spotlight-V100", "store.db"), "x");
    fs.writeFileSync(path.join(src, ".Trashes", "junk"), "x");
    fs.writeFileSync(path.join(src, "Thumbs.db"), "x");
    assert.equal(run("start").status, 0);
    await copy(port, src, path.join(work, "kept-clean"));
    assert.deepEqual(names(path.join(work, "kept-clean", "card")).filter((n) => !n.includes("/") || n.endsWith(".mxf")), ["CLIP", "CLIP/one.mxf"], "only the real clip is copied");
    assert.deepEqual(names(path.join(work, "kept-clean")).filter((n) => /DS_Store|Spotlight|Trashes|Thumbs|\._/.test(n)), []);
    await copy(port, src, path.join(work, "everything"), { skipSystemFiles: false });
    const all = names(path.join(work, "everything"));
    for (const must of ["card/.DS_Store", "card/CLIP/._one.mxf", "card/.Spotlight-V100/store.db", "card/Thumbs.db"]) assert.ok(all.includes(must), `${must} is copied when skipping is off`);
    // the new routes refuse what they should
    assert.equal((await request(port, "POST", "/api/reveal", { jobId: "nope", path: work })).status, 400);
    assert.equal((await request(port, "POST", "/api/folders", { path: work, name: "x", root: work, identity: "nope" })).status, 400);
  } finally {
    run("stop");
    fs.rmSync(work, { recursive: true, force: true });
  }
});
