"use strict";
// Volumes, capacity, folder lists and the source/destination rules.
// Node stdlib only. The rules run on the server for every way a job can arrive.
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const platform = require("./platform");

const VOLUMES_ROOT = "/Volumes"; // macOS only; other systems list mounts through platform.js
const VOLUME_UUID_PREFIX = "volume-uuid:";
const DISKUTIL_CACHE_MS = 5000;
// diskutil can take 8 s or more on a drive that is busy copying. A short limit made the lookup fail, and the failure
// was cached, so a refreshed page was refused for a missing drive identity in the middle of an offload.
const DISKUTIL_TIMEOUT_MS = 30000;
const DISKUTIL_FAIL_RETRY_MS = 2000;
const lastGoodUuid = new Map(); // mount + device -> uuid, used only when a lookup fails, dropped when the mount disappears
const FOLDER_LIST_MAX = 500;
const SCAN_MAX_ENTRIES = 300000;
const SCAN_MAX_MS = 4000;
const JOB_MODES = ["force", "noexist", "diff", "newer", "sync", "move", "delete", "verify-only"];
const DESTRUCTIVE_MODES = new Set(["sync", "move", "delete"]);
const diskutilCache = new Map();

/** df -kP rows: Filesystem 1024-blocks Used Available Capacity Mounted on. */
function parseDf(text) {
  const rows = [];
  for (const line of String(text || "").split("\n").slice(1)) {
    // Only the start is trimmed: a card can be named with a trailing space, and that space is part of its mount point.
    const m = line.replace(/^\s+/, "").replace(/\r$/, "").match(/^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    rows.push({
      filesystem: m[1],
      totalBytes: Number(m[2]) * 1024,
      usedBytes: Number(m[3]) * 1024,
      availBytes: Number(m[4]) * 1024,
      mount: m[6],
    });
  }
  return rows;
}

function parseDiskutilUuid(text) {
  const value = (key) => {
    const match = String(text || "").match(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`));
    return match ? match[1].trim() : "";
  };
  const uuid = value("VolumeUUID") || value("DiskUUID");
  return uuid ? uuid.toLowerCase() : null;
}

function volumeIdentity(uuid) {
  return uuid ? `${VOLUME_UUID_PREFIX}${String(uuid).toLowerCase()}` : null;
}

function isVolumeUuidIdentity(identity) {
  return typeof identity === "string" && /^volume-uuid:[0-9a-f-]{16,64}$/i.test(identity);
}

function diskutilUuidForMount(mount, { refresh = false, run = execFile, device = "" } = {}) {
  const now = Date.now();
  const cached = diskutilCache.get(mount);
  if (cached && (cached.pending || (!refresh && cached.expiresAt > now))) return cached.promise;
  let resolveResult;
  const promise = new Promise((resolve) => { resolveResult = resolve; });
  const record = { expiresAt: now + DISKUTIL_CACHE_MS, pending: true, promise };
  diskutilCache.set(mount, record);
  const key = `${mount}|${device}`;
  const finish = (uuid) => {
    record.pending = false;
    if (uuid) lastGoodUuid.set(key, uuid);
    // A failed lookup keeps the last identity read for this same mount and device, and is retried soon.
    record.expiresAt = Date.now() + (uuid ? DISKUTIL_CACHE_MS : DISKUTIL_FAIL_RETRY_MS);
    resolveResult(uuid || lastGoodUuid.get(key) || null);
  };
  try {
    run("diskutil", ["info", "-plist", mount], { encoding: "utf8", timeout: DISKUTIL_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      finish(err ? null : parseDiskutilUuid(stdout));
    });
  } catch {
    finish(null);
  }
  return promise;
}

async function loadDf({ refresh = false } = {}) {
  if (platform.HERE === "win32") return platform.loadWindowsVolumes();
  const entries = await new Promise((resolve) => {
    execFile("df", ["-kP"], { encoding: "utf8" }, (err, stdout) => {
      resolve(err ? [] : parseDf(stdout));
    });
  });
  const wanted = platform.HERE === "darwin" ? /^\/dev\/disk/ : /^\/dev\//;
  const mounts = [...new Set(entries
    .filter((row) => wanted.test(row.filesystem) && row.mount)
    .map((row) => row.mount))];
  if (platform.HERE !== "darwin") {
    // Linux: the UUID of each mount comes from findmnt. A mount without one has no identity and is refused for copying.
    const uuids = await platform.loadLinuxUuids();
    return entries.map((row) => ({ ...row, volumeUuid: uuids.get(row.mount) || null }));
  }
  const deviceOf = new Map(entries.map((row) => [row.mount, row.filesystem]));
  const live = new Set(mounts.map((mount) => `${mount}|${deviceOf.get(mount)}`));
  for (const key of [...lastGoodUuid.keys()]) if (!live.has(key)) lastGoodUuid.delete(key);
  const uuids = await Promise.all(mounts.map(async (mount) => [mount, await diskutilUuidForMount(mount, { refresh, device: deviceOf.get(mount) })]));
  const byMount = new Map(uuids);
  return entries.map((row) => ({ ...row, volumeUuid: byMount.get(row.mount) || null }));
}

/** The row whose mount is the longest prefix of the path. */
function mountFor(entries, real) {
  let best = null;
  for (const row of entries) {
    const hit = platform.insideMount(real, row.mount);
    if (hit && (!best || row.mount.length > best.mount.length)) best = row;
  }
  // A path on an external drive must never be matched to the startup disk just because its own drive was not found (an odd
  // name, a different spelling of an accent). That made an SD card look like the OS drive. Look again loosely, and if the drive
  // still cannot be found, say "unknown" (null), never "startup disk".
  const external = platform.externalMountOf(real);
  if (external && (!best || platform.startupMounts().has(best.mount))) {
    const loose = (p) => String(p).normalize("NFC").trimEnd().toLowerCase();
    const wanted = loose(external);
    return entries.find((row) => loose(row.mount) === wanted) || null;
  }
  return best;
}

/** A df disk prefix is only a hint; it does not prove shared physical media. */
function diskKey(filesystem) {
  return platform.diskKey(filesystem);
}

function identityForPath(p, entries) {
  return locateVolume(p, entries)?.identity || null;
}

/** Resolve any path, including a not-yet-created destination, through its nearest existing ancestor. */
function locateVolume(input, entries) {
  const resolved = resolvePath(input);
  const row = mountFor(entries, resolved.ancestor);
  if (!row) return null;
  return {
    ...resolved,
    filesystem: row.filesystem,
    mountPoint: row.mount,
    device: diskKey(row.filesystem),
    identity: volumeIdentity(row.volumeUuid),
    startup: STARTUP_MOUNTS.has(row.mount),
  };
}

async function locateVolumeForPath(input) {
  return locateVolume(input, await loadDf());
}

function captureBindings(paths, savedBindings, entries) {
  const saved = new Map((savedBindings || []).map((binding) => [String(binding.path), binding]));
  const unique = [...new Set(paths || [])];
  return unique.flatMap((p) => {
    const current = locateVolume(p, entries);
    const previous = saved.get(p);
    const identity = isVolumeUuidIdentity(previous?.identity) ? previous.identity : current?.identity;
    if (!identity) return [];
    return [{
      path: p,
      identity,
      root: previous?.root || current?.mountPoint || null,
      name: previous?.name || (current?.mountPoint ? path.basename(current.mountPoint) : null),
    }];
  });
}

const STARTUP_MOUNTS = platform.startupMounts();

function realOrSame(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function probeReal(p) {
  let readable = false;
  let writable = false;
  let dev = null;
  try {
    dev = fs.statSync(p).dev;
  } catch {
    /* unavailable */
  }
  try {
    fs.accessSync(p, fs.constants.R_OK);
    readable = true;
  } catch {
    /* not readable */
  }
  try {
    fs.accessSync(p, fs.constants.W_OK);
    writable = true;
  } catch {
    /* not writable */
  }
  return { readable, writable, dev };
}

/**
 * One card per mounted volume. Pure when `realpath` and `probe` are injected, so the
 * parsing and the role reasons are testable with a fixed df sample.
 */
function buildVolumeCards({ names, entries, appDir, realpath = realOrSame, probe = probeReal }) {
  return names.map((entry) => {
    const absolute = path.isAbsolute(entry);
    const p = absolute ? entry : path.join(VOLUMES_ROOT, entry);
    const root = realpath(p);
    const row = mountFor(entries, root);
    const known = !!row && row.totalBytes > 0;
    const totalBytes = known ? row.totalBytes : null;
    const freeBytes = known ? row.availBytes : null;
    const usedBytes = known ? Math.max(0, row.totalBytes - row.availBytes) : null;
    const usedPercent = known ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null;
    const startup = !!row && STARTUP_MOUNTS.has(row.mount);
    const access = probe(root);
    const holdsApp = !!appDir && platform.insideMount(appDir, root) && root !== path.parse(root).root;
    let source = { allowed: true, reason: "" };
    let destination = { allowed: true, reason: "" };
    if (!access.readable) {
      source = { allowed: false, reason: "Not readable" };
    }
    if (startup) {
      destination = { allowed: false, reason: "Startup disk is not offered as a destination" };
    } else if (holdsApp) {
      destination = { allowed: false, reason: "Holds the app's own folder" };
    } else if (!access.writable) {
      destination = { allowed: false, reason: access.readable ? "Read-only" : "Not readable" };
    }
    const name = absolute ? (row?.label ? `${row.label} (${p.replace(/[\\/]+$/, "")})` : p === "/" ? "System" : path.basename(p) || p) : entry;
    return {
      name,
      path: p,
      root,
      mount: row ? row.mount : null,
      filesystem: row ? row.filesystem : null,
      device: row ? diskKey(row.filesystem) : null,
      identity: row ? identityForPath(p, entries) : null,
      totalBytes,
      usedBytes,
      freeBytes,
      usedPercent,
      capacityKnown: known,
      status: access.readable ? "ready" : "unreadable",
      readable: access.readable,
      writable: access.writable,
      startup,
      source,
      destination,
    };
  });
}

async function listVolumes({ appDir, entries: providedEntries } = {}) {
  const entries = providedEntries || await loadDf();
  let names = [];
  if (platform.HERE === "darwin") {
    try {
      names = fs.readdirSync(VOLUMES_ROOT).filter((n) => {
        try {
          return fs.statSync(path.join(VOLUMES_ROOT, n)).isDirectory();
        } catch {
          return false;
        }
      });
    } catch {
      return [];
    }
  } else if (platform.HERE === "win32") {
    names = entries.map((row) => row.mount);
  } else {
    names = ["/"];
    for (const parent of platform.mountParents()) {
      try {
        for (const n of fs.readdirSync(parent)) {
          const full = path.join(parent, n);
          if (fs.statSync(full).isDirectory() && entries.some((row) => row.mount === full)) names.push(full);
        }
      } catch {
        /* parent absent */
      }
    }
    names = [...new Set(names)];
  }
  return buildVolumeCards({ names, entries, appDir });
}

/** A folder name is one plain segment: no separators, no dot names, nothing hidden, nothing a Finder or Explorer would refuse. */
function checkFolderName(name) {
  if (typeof name !== "string") throw new Error("a folder name is required");
  const n = name.trim();
  if (!n) throw new Error("type a name for the new folder");
  if (n.length > 120) throw new Error("that folder name is too long (120 characters at most)");
  if (n === "." || n === ".." || n.startsWith(".")) throw new Error("a folder name cannot start with a dot, it would be hidden");
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(n)) throw new Error('a folder name cannot contain  / \\ : * ? " < > |');
  if (/[ .]$/.test(n)) throw new Error("a folder name cannot end with a dot");
  return n;
}

/**
 * Makes one new folder inside the selected volume. Only on a drive that is allowed as a destination, so a camera card being
 * read is never written to. An existing folder of that name is simply used.
 */
function createFolder(parent, name, root, identity, entries = [], { destinationAllowed = true } = {}) {
  const clean = checkFolderName(name);
  if (!destinationAllowed) throw new Error("this drive is not offered as a destination, so folders cannot be made on it");
  if (typeof parent !== "string" || !path.isAbsolute(parent)) throw new Error("an absolute parent folder is required");
  if (typeof root !== "string" || !path.isAbsolute(root) || !identity) throw new Error("a selected volume root and identity are required");
  const realRoot = fs.realpathSync(root);
  const currentIdentity = identityForPath(realRoot, entries);
  if (!currentIdentity || currentIdentity !== identity) throw new Error("Selected volume changed or is unavailable; choose it again");
  const realParent = fs.realpathSync(parent);
  if (!inside(realParent, realRoot)) throw new Error("folder is outside the selected volume");
  if (!fs.statSync(realParent).isDirectory()) throw new Error("not a folder: " + parent);
  const target = path.join(realParent, clean);
  if (fs.existsSync(target)) {
    if (!fs.statSync(target).isDirectory()) throw new Error(`a file named ${clean} already exists here`);
    return { path: realOrSame(target), created: false };
  }
  fs.mkdirSync(target);
  return { path: realOrSame(target), created: true };
}

/** Sub folders within the selected volume only. Symlink targets outside are omitted. */
function listFolders(dir, root, identity, entries = []) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error("an absolute folder path is required");
  }
  if (typeof root !== "string" || !path.isAbsolute(root) || !identity) {
    throw new Error("a selected volume root and identity are required");
  }
  const realRoot = fs.realpathSync(root);
  const currentIdentity = identityForPath(realRoot, entries);
  if (!currentIdentity || currentIdentity !== identity) throw new Error("Selected volume changed or is unavailable; choose it again");
  const real = fs.realpathSync(dir);
  if (!inside(real, realRoot)) throw new Error("folder is outside the selected volume");
  if (!fs.statSync(real).isDirectory()) throw new Error("not a folder: " + dir);
  const folders = [];
  let truncated = false;
  for (const ent of fs.readdirSync(real, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const full = path.join(real, ent.name);
    let isDir = ent.isDirectory();
    if (!isDir && ent.isSymbolicLink()) {
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    if (folders.length >= FOLDER_LIST_MAX) {
      truncated = true;
      break;
    }
    const resolved = realOrSame(full);
    if (!inside(resolved, realRoot)) continue;
    folders.push({ name: ent.name, path: resolved });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const parent = real === realRoot ? null : path.dirname(real);
  return { path: real, root: realRoot, identity: currentIdentity, parent, folders, truncated };
}

/** Quick size scan: files only, symlinks not followed, bounded by count and time. Yields to the event loop. */
async function scanSources(paths, { maxEntries = SCAN_MAX_ENTRIES, maxMs = SCAN_MAX_MS } = {}) {
  const started = Date.now();
  const sources = [];
  let seen = 0;
  let partial = false;
  for (const p of paths) {
    let bytes = 0;
    let files = 0;
    const stack = [p];
    while (stack.length) {
      if (seen >= maxEntries || Date.now() - started > maxMs) {
        partial = true;
        break;
      }
      const cur = stack.pop();
      seen++;
      // Let other requests (job polling) run during a long scan.
      if (seen % 2000 === 0) await new Promise((resolve) => setImmediate(resolve));
      let st;
      try {
        st = fs.lstatSync(cur);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        try {
          for (const name of fs.readdirSync(cur)) stack.push(path.join(cur, name));
        } catch {
          /* unreadable folder: counted as nothing */
        }
      } else if (st.isFile()) {
        bytes += st.size;
        files++;
      }
    }
    sources.push({ path: p, bytes, files });
    if (partial) break;
  }
  return {
    sources,
    totalBytes: sources.reduce((a, s) => a + s.bytes, 0),
    totalFiles: sources.reduce((a, s) => a + s.files, 0),
    partial,
  };
}

/** Real path of the nearest existing ancestor, plus the part that does not exist yet. */
function resolvePath(input) {
  const abs = path.resolve(String(input));
  let existing = abs;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = realOrSame(existing);
  let dev = null;
  try {
    dev = fs.statSync(real).dev;
  } catch {
    /* unknown */
  }
  return {
    input: String(input),
    resolved: rest.length ? path.join(real, ...rest) : real,
    exists: rest.length === 0,
    ancestor: real,
    dev,
  };
}

function inside(child, parent) {
  return platform.insideMount(child, parent);
}

function volumeNameOf(real) {
  const mount = platform.externalMountOf(real);
  return mount ? path.basename(mount) || mount : "the startup disk";
}

/**
 * The source/destination rules. Returns every problem found, never throws.
 * fields: { src, dest, mode, diskMode }; entries: parsed df rows (for physical disks).
 */
function validateJob(fields, { appDir, entries = [], startupDevs: startupOverride, requireVolumeBindings = false, devForPath = (p) => resolvePath(p).dev } = {}) {
  const errors = [];
  const warnings = [];
  const src = (fields.src || []).map((p) => ({ ...resolvePath(p), dev: devForPath(p) }));
  const dest = (fields.dest || []).map((p) => ({ ...resolvePath(p), dev: devForPath(p) }));
  const verifyOnly = fields.mode === "verify-only";
  const startupDevs = startupOverride || new Set();
  if (!startupOverride) {
    for (const p of platform.startupMounts()) {
      try {
        startupDevs.add(fs.statSync(p).dev);
      } catch {
        /* not present */
      }
    }
  }
  const disk = (r) => {
    const row = mountFor(entries, r.ancestor);
    return row ? diskKey(row.filesystem) : null;
  };
  const bindings = new Map((fields.volumeBindings || []).map((b) => [String(b.path), String(b.identity)]));
  for (const p of [...src, ...dest]) {
    const current = identityForPath(p.input, entries);
    const old = bindings.get(p.input);
    if (old && !isVolumeUuidIdentity(old)) errors.push(`Saved drive identity for ${p.input} has no volume UUID; choose the drive again before starting or resuming`);
    else if (old && current !== old) errors.push(`Selected volume changed or is unavailable for ${p.input}; choose it again`);
    else if (platform.externalMountOf(p.input) && !old) {
      errors.push(`Volume identity is missing for ${p.input}; open the job on the page and choose the drives once to save their bindings`);
    }
  }

  for (const s of src) {
    if (!s.exists) {
      errors.push(`Source does not exist: ${s.input}`);
      continue;
    }
    try {
      fs.accessSync(s.resolved, fs.constants.R_OK);
    } catch {
      errors.push(`Source cannot be read: ${s.input}`);
    }
  }

  const seenDest = new Set();
  for (const d of dest) {
    const mount = platform.externalMountOf(d.resolved);
    if (mount && !fs.existsSync(mount)) {
      errors.push(`Destination volume is not mounted: ${mount}`);
      continue;
    }
    if (seenDest.has(d.resolved)) {
      errors.push(`Destination is listed twice: ${d.input}`);
    }
    seenDest.add(d.resolved);
    let ok = true;
    try {
      if (!fs.statSync(d.ancestor).isDirectory()) ok = false;
      fs.accessSync(d.ancestor, fs.constants.W_OK);
    } catch {
      ok = false;
    }
    if (!ok) errors.push(`Destination cannot be written: ${d.input}`);
    if (appDir && inside(d.resolved, realOrSame(appDir))) {
      errors.push(`Destination is inside the app's own folder: ${d.input}`);
    }
  }

  for (const s of src) {
    for (const d of dest) {
      if (!s.exists) continue;
      if (s.resolved === d.resolved) {
        errors.push(`Destination is the same folder as the source: ${d.input}`);
      } else if (inside(d.resolved, s.resolved)) {
        errors.push(`Destination ${d.input} is inside source ${s.input}`);
      } else if (inside(s.resolved, d.resolved)) {
        errors.push(`Source ${s.input} is inside destination ${d.input}`);
      }
      if (verifyOnly || s.dev == null || d.dev == null) continue;
      if (s.dev === d.dev) {
        if (startupDevs.has(s.dev)) {
          const note = `Source ${s.input} and destination ${d.input} are both on the startup disk, so this is not an independent copy`;
          if (!warnings.includes(note)) warnings.push(note);
        } else {
          errors.push(
            `Source ${s.input} and destination ${d.input} are on the same volume (${volumeNameOf(s.ancestor)}). Choose a destination on a different drive`
          );
        }
      } else {
        const a = disk(s);
        if (a && a === disk(d)) {
          const note = `Source ${s.input} and destination ${d.input} have the same df disk identifier (${a}); physical independence cannot be established from this identifier alone`;
          if (!warnings.includes(note)) warnings.push(note);
        }
      }
    }
  }
  return { errors, warnings, src, dest };
}

/** Start-path checks shared by HTTP and MCP before either route launches the engine. */
function validateStart(fields, options = {}) {
  const result = validateJob(fields, options);
  const errors = [];
  if (!Array.isArray(fields.src) || !fields.src.filter(Boolean).length || !Array.isArray(fields.dest) || !fields.dest.filter(Boolean).length) {
    errors.push("src and dest required (non-empty arrays)");
  }
  if (!JOB_MODES.includes(fields.mode || "force")) {
    errors.push(`mode must be one of ${JOB_MODES.join(", ")}`);
  }
  if (DESTRUCTIVE_MODES.has(fields.mode || "force") && !fields.confirm) {
    errors.push(`mode ${fields.mode} requires confirm: true`);
  }
  return { ...result, errors: [...errors, ...result.errors] };
}

function human(n) {
  if (n == null) return "unavailable";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let v = Number(n);
  let i = 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

/** Free space per destination against the planned bytes, with the sum explained. */
function spaceCheck(destResolved, scan, entries) {
  const parts = scan.sources.map((s) => `${s.path}: ${human(s.bytes)}`);
  return destResolved.map((d) => {
    const row = mountFor(entries, d.ancestor);
    const freeBytes = row ? row.availBytes : null;
    const short = freeBytes != null && freeBytes < scan.totalBytes;
    return {
      path: d.input,
      freeBytes,
      neededBytes: scan.totalBytes,
      short,
      explanation:
        `Every destination receives all sources, so each needs ${human(scan.totalBytes)}` +
        (parts.length > 1 ? ` (${parts.join(" + ")})` : "") +
        (scan.partial ? ", counted from a partial scan" : "") +
        ". Filters and skipped files can lower the real figure.",
    };
  });
}

module.exports = {
  parseDf,
  parseDiskutilUuid,
  volumeIdentity,
  isVolumeUuidIdentity,
  diskutilUuidForMount,
  loadDf,
  mountFor,
  diskKey,
  identityForPath,
  locateVolume,
  locateVolumeForPath,
  captureBindings,
  buildVolumeCards,
  listVolumes,
  listFolders,
  createFolder,
  checkFolderName,
  scanSources,
  resolvePath,
  validateJob,
  validateStart,
  spaceCheck,
  human,
};
