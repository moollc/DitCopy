#!/usr/bin/env node
"use strict";
// Checks that a packaged copy does not depend on the machine that built it. Run on every package before it is offered.
//   node scripts/audit-bundle.js <bundleDir> [--also-forbid <text>]...
//   node scripts/audit-bundle.js --app <DitCopy.app>      the same checks for a macOS app, plus its plist, program and signature
// It fails on: a build machine path or user name inside any text file, a Node that is a launcher stub, programs that need
// libraries outside the system (otool on macOS, ldd on Linux), missing run permission on the launch scripts.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(path.join(__dirname, ".."));
const MAX_GLIBC = [2, 35]; // the oldest Linux we support is Ubuntu 22.04

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

const isBinary = (buf) => buf.subarray(0, 4096).includes(0);

/** Strings that must not appear in a download: where it was built, and who built it. */
function forbiddenStrings(extra = []) {
  const user = os.userInfo().username;
  const found = [os.homedir(), ROOT, path.dirname(ROOT)];
  if (user && user.length > 2) found.push(`/Users/${user}`, `/home/${user}`, `\\Users\\${user}`);
  return [...new Set([...found, ...extra])].filter((s) => s && s.length > 4 && s !== "/" && s !== os.tmpdir());
}

function auditText(bundle, forbidden) {
  const problems = [];
  for (const file of walk(bundle)) {
    const rel = path.relative(bundle, file);
    if (rel.startsWith(`runtime${path.sep}`) || rel.startsWith(`engine${path.sep}`)) continue; // binaries are checked below
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    for (const bad of forbidden) if (text.includes(bad)) problems.push(`${rel} contains the build machine's path or name: ${bad}`);
  }
  return problems;
}

function auditBinaries(bundle, plat) {
  const problems = [];
  const win = plat === "win32";
  const node = path.join(bundle, "runtime", win ? "node.exe" : "node");
  const engine = path.join(bundle, "engine", win ? "ditcopy_engine.exe" : "ditcopy_engine");
  if (!fs.existsSync(node)) problems.push("runtime/node is missing, so it would need Node installed");
  else if (fs.statSync(node).size < 20 * 1024 * 1024) problems.push("runtime/node is a launcher stub, not a self contained Node");
  if (!fs.existsSync(engine)) problems.push("the engine program is missing");
  for (const bin of [node, engine].filter((f) => fs.existsSync(f))) {
    if (plat === "darwin") {
      const out = spawnSync("otool", ["-L", bin], { encoding: "utf8" });
      for (const line of String(out.stdout || "").split("\n").slice(1)) {
        const lib = line.trim().split(" ")[0];
        if (lib && !/^(\/usr\/lib\/|\/System\/Library\/)/.test(lib)) problems.push(`${path.relative(bundle, bin)} needs ${lib}, which is not part of macOS`);
      }
    } else if (plat === "linux") {
      const out = spawnSync("ldd", [bin], { encoding: "utf8" });
      for (const line of String(out.stdout || "").split("\n")) if (/not found/.test(line)) problems.push(`${path.relative(bundle, bin)} needs a library that is missing: ${line.trim()}`);
      // A program built on a very new Linux will not start on an older one. Ubuntu 22.04 has glibc 2.35.
      const syms = spawnSync("objdump", ["-T", bin], { encoding: "utf8" });
      const versions = [...String(syms.stdout || "").matchAll(/GLIBC_(\d+)\.(\d+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      const newest = versions.sort((a, b) => a[0] - b[0] || a[1] - b[1]).pop();
      if (newest && (newest[0] > MAX_GLIBC[0] || (newest[0] === MAX_GLIBC[0] && newest[1] > MAX_GLIBC[1]))) {
        problems.push(`${path.relative(bundle, bin)} needs glibc ${newest.join(".")}, newer than ${MAX_GLIBC.join(".")}: build on an older Linux (ubuntu-22.04)`);
      }
    }
  }
  return problems;
}

function auditPermissions(bundle, plat) {
  if (plat === "win32") return [];
  const problems = [];
  for (const f of ["start.command", "stop.command", "start.sh", "stop.sh", "runtime/node", "engine/ditcopy_engine"]) {
    const full = path.join(bundle, f);
    if (fs.existsSync(full) && (fs.statSync(full).mode & 0o111) === 0) problems.push(`${f} is not marked executable`);
  }
  return problems;
}

function audit(bundle, { plat = process.platform, extra = [] } = {}) {
  if (!fs.existsSync(path.join(bundle, "bundle.json"))) return ["bundle.json is missing, this is not a packaged copy"];
  return [...auditText(bundle, forbiddenStrings(extra)), ...auditBinaries(bundle, plat), ...auditPermissions(bundle, plat)];
}

/** A macOS app: the packaged copy inside it, the plist, the Swift program's libraries, and a valid signature. */
function auditApp(app, { extra = [] } = {}) {
  const problems = [];
  const inner = path.join(app, "Contents", "Resources", "ditcopy");
  if (!fs.existsSync(inner)) return [`${app} carries no packaged copy (Contents/Resources/ditcopy), so it would need the folder it was built from`];
  problems.push(...audit(inner, { plat: "darwin", extra }));
  const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
  if (/DitCopyRoot/.test(plist)) problems.push("Info.plist still names a folder to run from (DitCopyRoot)");
  for (const bad of forbiddenStrings(extra)) if (plist.includes(bad)) problems.push(`Info.plist contains the build machine's path or name: ${bad}`);
  const exe = path.join(app, "Contents", "MacOS", "DitCopy");
  if (!fs.existsSync(exe)) problems.push("the app program is missing");
  else {
    const out = spawnSync("otool", ["-L", exe], { encoding: "utf8" });
    for (const line of String(out.stdout || "").split("\n").slice(1)) {
      const lib = line.trim().split(" ")[0];
      if (lib && !/^(\/usr\/lib\/|\/System\/Library\/)/.test(lib)) problems.push(`the app program needs ${lib}, which is not part of macOS`);
    }
  }
  const sig = spawnSync("codesign", ["--verify", "--deep", "--strict", app], { encoding: "utf8" });
  if (sig.status !== 0) problems.push(`the app signature does not verify: ${String(sig.stderr || "").trim()}`);
  if (!fs.existsSync(path.join(app, "Contents", "Resources", "icon.icns"))) problems.push("the app icon is missing");
  return problems;
}

module.exports = { audit, auditApp, forbiddenStrings };

if (require.main === module) {
  const isApp = process.argv[2] === "--app";
  const bundle = isApp ? process.argv[3] : process.argv[2];
  if (!bundle) { console.error("Usage: node scripts/audit-bundle.js <bundleDir> | --app <DitCopy.app>"); process.exit(2); }
  const extra = process.argv.flatMap((a, i, all) => (a === "--also-forbid" ? [all[i + 1]] : []));
  const problems = isApp ? auditApp(path.resolve(bundle), { extra }) : audit(path.resolve(bundle), { extra });
  if (problems.length) { console.error("BUNDLE AUDIT FAILED:\n  - " + problems.join("\n  - ")); process.exit(1); }
  console.log(`bundle audit passed for ${path.basename(path.resolve(bundle))}: no build machine paths, self contained programs, run permissions set`);
}
