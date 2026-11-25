"use strict";
// Run: node --test server/portability.test.js
// A lint written as a test, so it runs locally and in CI on macOS, Linux and Windows. It fails on habits that only work on
// a Mac. Each rule came from a real failure in this project:
//   /private/tmp in a test           failed every file test on Linux (CI, 25 Nov 2026)
//   process.title                    on macOS it spilled part of the environment, a token included, into `ps`
//   macOS tools outside their files  broke Linux and Windows. Drive tools belong in platform.js, drive-eject.js and drive-links.js.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const SKIP_DIRS = new Set(["node_modules", "target", "logs", ".git", "app"]);

function files(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const source = [...files(path.join(ROOT, "engine", "src"), [".rs"]), ...files(path.join(ROOT, "server"), [".js"]),
  ...files(path.join(ROOT, "ui"), [".js"]), ...files(path.join(ROOT, "mcp"), [".js"]), path.join(ROOT, "ditcopy.js")];

function offenders(re, { allow = [], skipSelf = true } = {}) {
  return source.filter((f) => {
    const name = rel(f);
    if (skipSelf && name === "server/portability.test.js") return false;
    if (allow.includes(name)) return false;
    return re.test(fs.readFileSync(f, "utf8"));
  }).map(rel);
}

test("no hard coded macOS temp folder used for real files", () => {
  // Plain strings used as sample data are fine. A folder or file created there is not.
  const makes = /(mkdirSync|writeFileSync|mkdtempSync|create_dir_all|fs::write|File::create|PathBuf::from)[^\n]*\/private\/tmp|\/private\/tmp[^\n]*(mkdirSync|writeFileSync|mkdtempSync)/;
  assert.deepStrictEqual(offenders(makes), [], "use std::env::temp_dir() or os.tmpdir()");
});

test("nothing sets the process title", () => {
  assert.deepStrictEqual(offenders(/process\.title\s*=/), [], "process.title exposes environment values in ps on macOS");
});

test("macOS only programs are called from the files that gate them by system", () => {
  const allowed = ["server/platform.js", "server/drive-eject.js", "server/drive-links.js", "server/volumes.js", "server/drive-speed.js"];
  const bad = offenders(/(execFile|spawn|run|runCommand)\(\s*["'](diskutil|caffeinate|plutil|system_profiler|osascript)["']/, { allow: allowed });
  assert.deepStrictEqual(bad, [], "call these through platform.js so other systems get a clear answer");
});

test("the engine never opens a folder as a file without a Unix guard", () => {
  const text = fs.readFileSync(path.join(ROOT, "engine", "src", "checkpoint.rs"), "utf8");
  const at = text.indexOf("File::open(parent)");
  assert.ok(at > 0, "directory sync not found, update this rule if it moved");
  assert.match(text.slice(Math.max(0, at - 300), at), /#\[cfg\(unix\)\]/, "Windows cannot open a folder as a file");
});

test("volumes are never matched by a literal /Volumes outside the system gates", () => {
  const allowed = ["server/platform.js", "server/volumes.js", "server/volumes.test.js", "server/drive-eject.js", "server/drive-eject.test.js"];
  const bad = offenders(/startsWith\(\s*["']\/Volumes\//, { allow: allowed });
  assert.deepStrictEqual(bad, [], "use platform.externalMountOf(path)");
});
