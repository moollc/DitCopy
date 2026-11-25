"use strict";
// Volume parsing, role rules and job validation. Run: node --test server/
// These tests use macOS fixtures (/Volumes, disk5), so they run the macOS rules on every system. The Linux and Windows rules
// are tested in platform.test.js with their own sample output. Windows paths differ from the fixtures, so these skip there.
process.env.DITCOPY_PLATFORM = "darwin";
const nodeTest = require("node:test");
const test = (name, fn) => nodeTest(name, { skip: process.platform === "win32" && "macOS path fixtures" }, fn);
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const V = require("./volumes");
const R = require("../ui/roles");
const { validateLocalJob } = require("./local-validation");

const DF = `Filesystem     1024-blocks       Used Available Capacity Mounted on
/dev/disk3s1s1   482797652   12344176  26445088    32%    /
devfs                  215        215         0   100%    /dev
/dev/disk3s5   482797652  423739876  26445088    95%    /System/Volumes/Data
map auto_home            0          0         0   100%    /System/Volumes/Data/home
/dev/disk4s2    3906730240 3152464128 754266112    81%    /Volumes/LaCie
/dev/disk5s1    1000000     400000     600000    40%    /Volumes/My Drive
/dev/disk5s2    1000000     100000     900000    10%    /Volumes/Same Disk
/dev/disk6s1    1000000     1000     999000    1%    /Volumes/AppDisk
/dev/disk7s1    1000000     1000     999000    1%    /Volumes/Locked
`;

test("parseDf reads columns and mounts with spaces", () => {
  const rows = V.parseDf(DF);
  const lacie = rows.find((r) => r.mount === "/Volumes/LaCie");
  assert.strictEqual(lacie.totalBytes, 3906730240 * 1024);
  assert.strictEqual(lacie.availBytes, 754266112 * 1024);
  assert.ok(rows.find((r) => r.mount === "/Volumes/My Drive"));
  assert.strictEqual(V.diskKey("/dev/disk5s1"), "disk5");
  assert.strictEqual(V.diskKey("map auto_home"), null);
});

test("diskutil volume UUID takes precedence over disk UUID and is cached per mount", async () => {
  const volume = "A0B1C2D3-E4F5-6789-ABCD-0123456789AB";
  const disk = "11112222-3333-4444-5555-666677778888";
  const plist = (rows) => `<?xml version="1.0"?><plist><dict>${rows}</dict></plist>`;
  const pair = (key, value) => `<key>${key}</key><string>${value}</string>`;
  assert.equal(V.parseDiskutilUuid(plist(pair("VolumeUUID", volume) + pair("DiskUUID", disk))), volume.toLowerCase());
  assert.equal(V.parseDiskutilUuid(plist(pair("DiskUUID", disk))), disk.toLowerCase());
  assert.equal(V.volumeIdentity(volume), `volume-uuid:${volume.toLowerCase()}`);
  assert.equal(V.isVolumeUuidIdentity("disk4|42"), false);

  const mount = `/fixture/diskutil-${process.pid}-${Date.now()}`;
  let calls = 0;
  const run = (_file, _args, _options, callback) => {
    calls++;
    setImmediate(() => callback(null, plist(pair("VolumeUUID", volume))));
  };
  const [first, second] = await Promise.all([
    V.diskutilUuidForMount(mount, { run }),
    V.diskutilUuidForMount(mount, { run }),
  ]);
  assert.equal(first, volume.toLowerCase());
  assert.equal(second, first);
  assert.equal(calls, 1);
  const replacement = "99990000-AAAA-BBBB-CCCC-DDDDEEEEFFFF";
  const refreshed = await V.diskutilUuidForMount(mount, {
    refresh: true,
    run: (_file, _args, _options, callback) => setImmediate(() => callback(null, plist(pair("VolumeUUID", replacement)))),
  });
  assert.equal(refreshed, replacement.toLowerCase());
});

function cards(extra = {}) {
  const real = {
    "/Volumes/Macintosh HD": "/",
    "/Volumes/LaCie": "/Volumes/LaCie",
    "/Volumes/My Drive": "/Volumes/My Drive",
    "/Volumes/Ghost": "/Volumes/Ghost",
    "/Volumes/Locked": "/Volumes/Locked",
    "/Volumes/AppDisk": "/Volumes/AppDisk",
  };
  const probe = (p) => ({
    readable: p !== "/Volumes/Locked",
    writable: p !== "/Volumes/My Drive" && p !== "/Volumes/Locked",
    dev: 1,
  });
  return V.buildVolumeCards({
    names: Object.keys(real).map((p) => p.replace("/Volumes/", "")),
    entries: V.parseDf(DF),
    appDir: "/Volumes/AppDisk/DitCopy",
    realpath: (p) => real[p] || p,
    probe,
    ...extra,
  });
}

test("cards carry total, used, free, percent and say unavailable instead of 0", () => {
  const byName = Object.fromEntries(cards().map((c) => [c.name, c]));
  const l = byName.LaCie;
  assert.strictEqual(l.capacityKnown, true);
  assert.strictEqual(l.usedBytes, (3906730240 - 754266112) * 1024);
  assert.strictEqual(l.usedPercent, 80.7);
  assert.strictEqual(byName["My Drive"].usedPercent, 40);
  // Ghost has no df row but "/" matches as a fallback only through its own real path,
  // so a volume whose mount is not listed falls back to the root row. Locked is unreadable.
  const bare = V.buildVolumeCards({
    names: ["Nowhere"],
    entries: [],
    appDir: null,
    realpath: (p) => p,
    probe: () => ({ readable: true, writable: true, dev: 1 }),
  })[0];
  assert.strictEqual(bare.capacityKnown, false);
  assert.strictEqual(bare.totalBytes, null);
  assert.strictEqual(bare.freeBytes, null);
  assert.strictEqual(bare.usedPercent, null);
});

test("startup disk, read-only, unreadable and the app's own volume are not destinations", () => {
  const byName = Object.fromEntries(cards().map((c) => [c.name, c]));
  assert.strictEqual(byName["Macintosh HD"].startup, true);
  assert.strictEqual(byName["Macintosh HD"].destination.allowed, false);
  assert.strictEqual(byName["Macintosh HD"].source.allowed, true);
  assert.strictEqual(byName["My Drive"].destination.reason, "Read-only");
  assert.strictEqual(byName["My Drive"].source.allowed, true, "read-only media stays a valid source");
  assert.strictEqual(byName.Locked.source.allowed, false);
  assert.strictEqual(byName.Locked.status, "unreadable");
  assert.strictEqual(byName.AppDisk.destination.reason, "Holds the app's own folder");
  assert.strictEqual(byName.LaCie.destination.allowed, true);
});

test("role rules: exclusive both ways, clear frees the volume, unrelated lines stay", () => {
  const vols = cards();
  const lacie = vols.find((v) => v.name === "LaCie");
  const mine = vols.find((v) => v.name === "Same Disk") || { name: "Same Disk", path: "/Volumes/Same Disk", root: "/Volumes/Same Disk", source: { allowed: true }, destination: { allowed: true } };
  // 1. A is a source: A's Destination is blocked and labelled; B stays selectable.
  let roles = R.rolesFor([lacie, mine], ["/Volumes/LaCie/DCIM"], []);
  let a = R.buttonState(lacie, "destination", roles, false);
  assert.deepStrictEqual([a.blocked, a.label, a.action], [true, "Selected as source", "none"]);
  assert.strictEqual(R.buttonState(mine, "destination", roles, false).action, "add");
  assert.strictEqual(R.buttonState(lacie, "source", roles, false).action, "clear");
  // 2. B is a destination: B's Source is blocked; A remains source.
  roles = R.rolesFor([lacie, mine], ["/Volumes/LaCie/DCIM"], ["/Volumes/Same Disk/Backup"]);
  let b = R.buttonState(mine, "source", roles, false);
  assert.deepStrictEqual([b.blocked, b.label], [true, "Selected as destination"]);
  assert.strictEqual(R.buttonState(lacie, "source", roles, false).pressed, true);
  // 3. Clearing A frees it for either role and leaves the rest of the boxes alone.
  const srcText = "/Volumes/LaCie/DCIM\n/tmp/other-source";
  const cleared = R.clearLines(srcText, lacie);
  assert.strictEqual(cleared, "/tmp/other-source");
  roles = R.rolesFor([lacie, mine], cleared.split("\n"), ["/Volumes/Same Disk/Backup"]);
  assert.strictEqual(R.buttonState(lacie, "source", roles, false).action, "add");
  assert.strictEqual(R.buttonState(lacie, "destination", roles, false).action, "add");
  assert.strictEqual(R.clearLines("/Volumes/Same Disk/Backup\n/tmp/d", mine), "/tmp/d");
  // Name alone adds nothing: only addLine does, and it never duplicates.
  assert.strictEqual(R.addLine("/a", "/a"), "/a");
  // A blocked destination (startup) says why and stays blocked.
  const startup = vols.find((v) => v.name === "Macintosh HD");
  const st = R.buttonState(startup, "destination", R.rolesFor(vols, [], []), false);
  assert.deepStrictEqual([st.blocked, st.action], [true, "none"]);
  // A job running locks every button.
  assert.strictEqual(R.buttonState(lacie, "source", roles, true).action, "none");
  // Choosing a folder replaces the volume root line.
  assert.strictEqual(R.chooseFolderLine("/Volumes/LaCie\n/x", lacie, "/Volumes/LaCie/DCIM/A001"), "/Volumes/LaCie/DCIM/A001\n/x");
});

test("startup folders belong to the longest mount and clear only that volume", () => {
  const startup = { name: "Startup", path: "/", root: "/", mount: "/", startup: true };
  const external = { name: "Card", path: "/Volumes/Card", root: "/Volumes/Card", mount: "/Volumes/Card" };
  const vols = [startup, external];
  assert.strictEqual(R.belongs("/private/tmp/clip", startup, vols), true);
  assert.strictEqual(R.belongs("/Volumes/Card/DCIM", startup, vols), false);
  assert.strictEqual(R.belongs("/Volumes/Card/DCIM", external, vols), true);
  assert.strictEqual(
    R.clearLines("/private/tmp/clip\n/Volumes/Card/DCIM\n/tmp/other", startup, vols),
    "/Volumes/Card/DCIM"
  );
});

test("space labels distinguish a full upper bound from a partial count", () => {
  assert.strictEqual(R.spaceLabel({ partial: false }), "Planned (upper bound)");
  assert.strictEqual(R.spaceLabel({ partial: true }), "Counted so far (partial)");
});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-b3-unit-"));
}

test("validation refuses nesting, same folder, missing and repeated paths", () => {
  const root = tmp();
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "sub"), { recursive: true });
  const dst = path.join(root, "dst");
  fs.mkdirSync(dst);
  const v = (f) => V.validateJob({ mode: "force", ...f }, { startupDevs: new Set([fs.statSync(root).dev]) });
  assert.deepStrictEqual(v({ src: [src], dest: [dst] }).errors, []);
  assert.match(v({ src: [src], dest: [path.join(src, "sub", "copy")] }).errors.join("|"), /is inside source/);
  assert.match(v({ src: [path.join(src, "sub")], dest: [src] }).errors.join("|"), /is inside destination/);
  assert.match(v({ src: [src], dest: [src] }).errors.join("|"), /same folder as the source/);
  assert.match(v({ src: [path.join(root, "nope")], dest: [dst] }).errors.join("|"), /Source does not exist/);
  assert.match(v({ src: [src], dest: [dst, dst] }).errors.join("|"), /listed twice/);
  assert.match(v({ src: [src], dest: ["/Volumes/Definitely-Not-Mounted-B3/x"] }).errors.join("|"), /not mounted/);
  // Symlink alias of the source cannot be used to nest a destination inside it.
  const alias = path.join(root, "alias");
  fs.symlinkSync(src, alias);
  assert.match(v({ src: [src], dest: [path.join(alias, "copy")] }).errors.join("|"), /is inside source/);
});

test("validation refuses one non-startup volume as both, allows startup with a warning, and the explicit same-disk workflow", () => {
  const root = tmp();
  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  const dev = fs.statSync(root).dev;
  const run = (opts, fields = {}) =>
    V.validateJob({ mode: "force", src: [src], dest: [dst], ...fields }, opts);
  const external = run({ startupDevs: new Set() });
  assert.match(external.errors.join("|"), /same volume/);
  const startup = run({ startupDevs: new Set([dev]) });
  assert.deepStrictEqual(startup.errors, []);
  assert.match(startup.warnings.join("|"), /not an independent copy/);
  assert.match(run({ startupDevs: new Set() }, { diskMode: "same" }).errors.join("|"), /same volume/);
  assert.deepStrictEqual(run({ startupDevs: new Set() }, { mode: "verify-only", diskMode: "same" }).errors, []);
});

test("stale or missing saved volume identities are refused", () => {
  const root = tmp();
  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  const entries = [{ filesystem: "fixturefs", mount: "/", volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", totalBytes: 1, availBytes: 1 }];
  const current = V.identityForPath(src, entries);
  const stale = V.validateJob(
    { mode: "force", src: [src], dest: [dst], volumeBindings: [{ path: src, identity: "old-device|old-volume" }] },
    { entries, startupDevs: new Set([fs.statSync(root).dev]) }
  );
  assert.match(stale.errors.join("|"), /has no volume UUID; choose the drive again/);
  assert.ok(current);
  const oldSaved = V.validateJob(
    { mode: "force", src: ["/Volumes/OldCard/DCIM"], dest: [dst] },
    { entries, startupDevs: new Set() }
  );
  assert.match(oldSaved.errors.join("|"), /Volume identity is missing.*open the job on the page and choose the drives once to save their bindings/);
});

test("one volume resolver binds a not-yet-created destination to its nearest mounted parent", () => {
  const root = tmp();
  const mount = fs.realpathSync(root);
  const entries = [{ filesystem: "/dev/disk9s1", mount, volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", totalBytes: 100, availBytes: 80 }];
  const target = path.join(root, "new", "nested", "out");
  const found = V.locateVolume(target, entries);
  assert.equal(found.mountPoint, mount);
  assert.equal(found.identity, "volume-uuid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.equal(found.exists, false);
  assert.deepEqual(V.captureBindings([target], [], entries), [{
    path: target,
    identity: found.identity,
    root: mount,
    name: path.basename(mount),
  }]);
});

test("folder listing enforces selected root identity and drops escaping symlinks", () => {
  const root = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(root, "inside"));
  fs.mkdirSync(path.join(outside, "escape-target"));
  fs.symlinkSync(outside, path.join(root, "escape"));
  const entries = [{ filesystem: "fixturefs", mount: "/", volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", totalBytes: 1, availBytes: 1 }];
  const identity = V.identityForPath(root, entries);
  const listed = V.listFolders(root, root, identity, entries);
  assert.deepStrictEqual(listed.folders.map((f) => f.name), ["inside"]);
  assert.throws(() => V.listFolders(outside, root, identity, entries), /outside the selected volume/);
  assert.throws(() => V.listFolders(root, root, "replacement|device", entries), /volume changed/);
});

test("MCP local validation refuses invalid jobs before engine spawn", async () => {
  const root = tmp();
  const dst = path.join(root, "dst");
  fs.mkdirSync(dst);
  const result = validateLocalJob(
    { mode: "force", src: [path.join(root, "missing")], dest: [dst] },
    root,
    ""
  );
  assert.match(result.errors.join("|"), /Source does not exist/);
  assert.match(validateLocalJob({ src: [], dest: [dst], mode: "force" }, root, "").errors.join("|"), /src and dest required/);
  assert.match(validateLocalJob({ src: [dst], dest: [path.join(root, "out")], mode: "delete" }, root, "").errors.join("|"), /requires confirm/);
  const oldSaved = validateLocalJob(
    { mode: "force", src: ["/Volumes/OldCard/DCIM"], dest: ["/Volumes/Other/Backup"] },
    root,
    ""
  );
  assert.match(oldSaved.errors.join("|"), /Volume identity is missing.*open the job on the page and choose the drives once to save their bindings/);

  const mcp = fs.readFileSync(path.join(__dirname, "../mcp/server.js"), "utf8");
  const start = mcp.indexOf("async function spawnLocalJob(");
  const end = mcp.indexOf("\nfunction sanitizeName(", start);
  const localJobs = new Map();
  let spawnCount = 0;
  const sandbox = {
    makeJobId: () => "unit-invalid",
    localJobs,
    spawn: () => { spawnCount++; throw new Error("spawn must not run"); },
    volumes: {
      loadDf: async () => [],
      validateStart: (fields, options) => V.validateStart(fields, { ...options, entries: [] }),
    },
    ENGINE: "/fixture/engine",
    ROOT: root,
  };
  vm.createContext(sandbox);
  vm.runInContext(mcp.slice(start, end) + "; this.spawnLocalJob = spawnLocalJob;", sandbox);
  await assert.rejects(
    () => sandbox.spawnLocalJob({ mode: "force", src: [path.join(root, "missing")], dest: [dst] }),
    /Source does not exist/
  );
  assert.strictEqual(spawnCount, 0);
  await assert.rejects(
    () => sandbox.spawnLocalJob({ mode: "force", src: ["/Volumes/OldCard/DCIM"], dest: [dst] }),
    /Volume identity is missing.*open the job on the page and choose the drives once to save their bindings/
  );
  assert.strictEqual(spawnCount, 0);
});

test("a shared df disk prefix warns, while same-volume checks remain hard refusals", () => {
  const root = tmp();
  const src = path.join(root, "src");
  const dst = path.join(root, "dst");
  fs.mkdirSync(src);
  fs.mkdirSync(dst);
  const entries = [
    { filesystem: "/dev/disk90s1", mount: fs.realpathSync(src), totalBytes: 10, availBytes: 10 },
    { filesystem: "/dev/disk90s2", mount: fs.realpathSync(dst), totalBytes: 10, availBytes: 10 },
  ];
  const result = V.validateJob(
    { mode: "force", src: [src], dest: [dst] },
    { entries, startupDevs: new Set(), devForPath: (p) => (p === src ? 1 : 2) }
  );
  assert.deepStrictEqual(result.errors, []);
  assert.match(result.warnings.join("|"), /physical independence cannot be established/);
  const explicit = V.validateJob(
    { mode: "force", diskMode: "same", src: [src], dest: [dst] },
    { entries, startupDevs: new Set(), devForPath: (p) => (p === src ? 1 : 2) }
  );
  assert.deepStrictEqual(explicit.errors, []);
  assert.match(explicit.warnings.join("|"), /physical independence cannot be established/);
});

test("destinations inside the app's own folder are refused", () => {
  const root = tmp();
  const src = path.join(root, "src");
  fs.mkdirSync(src);
  const app = path.join(root, "app");
  fs.mkdirSync(app);
  const r = V.validateJob({ mode: "force", src: [src], dest: [path.join(app, "out")] }, { appDir: app, startupDevs: new Set([fs.statSync(root).dev]) });
  assert.match(r.errors.join("|"), /app's own folder/);
});

test("space check explains the sum, and the scan counts files", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "a"));
  fs.writeFileSync(path.join(root, "a", "one"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(root, "two"), Buffer.alloc(500));
  const scan = await V.scanSources([path.join(root, "a"), path.join(root, "two")]);
  assert.strictEqual(scan.totalBytes, 1500);
  assert.strictEqual(scan.totalFiles, 2);
  const entries = [{ filesystem: "/dev/disk9s1", totalBytes: 10000, usedBytes: 9000, availBytes: 1000, mount: "/" }];
  const [one] = V.spaceCheck([V.resolvePath(root)], scan, entries);
  assert.strictEqual(one.short, true);
  assert.match(one.explanation, /each needs 1\.50 KB/);
  assert.match(one.explanation, /\(.*: 1\.00 KB \+ .*: 500 B\)/);
  const [ok] = V.spaceCheck([V.resolvePath(root)], scan, [{ ...entries[0], availBytes: 5000 }]);
  assert.strictEqual(ok.short, false);
});

test("folder list returns real sub folders only and refuses relative paths", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "B"));
  fs.mkdirSync(path.join(root, "a"));
  fs.mkdirSync(path.join(root, ".hidden"));
  fs.writeFileSync(path.join(root, "file.txt"), "x");
  const entries = [{ filesystem: "fixturefs", mount: "/", volumeUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", totalBytes: 1, availBytes: 1 }];
  const identity = V.identityForPath(root, entries);
  const r = V.listFolders(root, root, identity, entries);
  assert.deepStrictEqual(r.folders.map((f) => f.name), ["a", "B"]);
  assert.throws(() => V.listFolders("relative/path"));
});

const plist = (rows) => `<?xml version="1.0"?><plist><dict>${rows}</dict></plist>`;
const pair = (key, value) => `<key>${key}</key><string>${value}</string>`;

test("a slow or failed diskutil lookup keeps the last identity for the same mount and device", async () => {
  const mount = "/Volumes/BusyDrive";
  const uuid = "AAAA1111-2222-3333-4444-555566667777";
  const ok = (_f, _a, _o, cb) => setImmediate(() => cb(null, plist(pair("VolumeUUID", uuid))));
  const timedOut = (_f, _a, _o, cb) => setImmediate(() => cb(Object.assign(new Error("timeout"), { killed: true })));
  assert.equal(await V.diskutilUuidForMount(mount, { refresh: true, device: "/dev/disk9s2", run: ok }), uuid.toLowerCase());
  assert.equal(await V.diskutilUuidForMount(mount, { refresh: true, device: "/dev/disk9s2", run: timedOut }), uuid.toLowerCase());
});

test("a failed lookup never lends another device's identity", async () => {
  const mount = "/Volumes/SwapDrive";
  const ok = (_f, _a, _o, cb) => setImmediate(() => cb(null, plist(pair("VolumeUUID", "BBBB1111-2222-3333-4444-555566667777"))));
  const fail = (_f, _a, _o, cb) => setImmediate(() => cb(new Error("boom")));
  await V.diskutilUuidForMount(mount, { refresh: true, device: "/dev/disk7s1", run: ok });
  assert.equal(await V.diskutilUuidForMount(mount, { refresh: true, device: "/dev/disk8s1", run: fail }), null);
});

test("diskutil gets a long limit, because a drive that is copying answers slowly", async () => {
  let seen;
  await V.diskutilUuidForMount("/Volumes/LimitDrive", { refresh: true, run: (_f, _a, options, cb) => { seen = options.timeout; setImmediate(() => cb(null, plist(pair("VolumeUUID", "CCCC1111-2222-3333-4444-555566667777")))); } });
  assert.ok(seen >= 20000, "timeout was " + seen);
});

// ---- an SD card must never be mistaken for the startup disk (reported 25 Nov 2026)

const dfHeader = "Filesystem 1024-blocks Used Available Capacity Mounted on\n";
const dfRoot = "/dev/disk3s1s1 488245288 11000000 100000000 10% /\n";

test("a card named with a trailing space keeps that space, so its path still matches its drive", () => {
  const rows = V.parseDf(dfHeader + dfRoot + "/dev/disk4s1 124000000 1000 123999000 1% /Volumes/CARD ");
  const card = rows.find((r) => r.filesystem === "/dev/disk4s1");
  assert.equal(card.mount, "/Volumes/CARD ");
  assert.equal(V.mountFor(rows, "/Volumes/CARD /PRIVATE").mount, "/Volumes/CARD ");
});

test("an accented card name matches whichever way macOS spells the accent", () => {
  const nfd = "/Volumes/CAMÉRA 1";
  const nfc = "/Volumes/CAMÉRA 1";
  const rows = V.parseDf(dfHeader + dfRoot + `/dev/disk4s1 124000000 1000 123999000 1% ${nfd}`);
  assert.equal(V.mountFor(rows, nfc).filesystem, "/dev/disk4s1");
  assert.equal(V.mountFor(rows, nfd + "/DCIM").filesystem, "/dev/disk4s1");
});

test("a path on an external drive that cannot be matched is unknown, never the startup disk", () => {
  const rows = V.parseDf(dfHeader + dfRoot);
  assert.equal(V.mountFor(rows, "/Volumes/SomethingNotListed/DCIM"), null);
  assert.equal(V.mountFor(rows, "/Users/someone/Desktop").mount, "/", "ordinary paths still belong to the startup disk");
});

test("a card whose drive row is missing is shown as unknown, not as the startup disk", () => {
  const rows = V.parseDf(dfHeader + dfRoot);
  const cards = V.buildVolumeCards({
    names: ["Macintosh HD", "MYSTERY CARD"], entries: rows, appDir: "/x",
    realpath: (p) => (p.endsWith("Macintosh HD") ? "/" : p),
    probe: () => ({ readable: true, writable: true, dev: 1 }),
  });
  const card = cards.find((c) => c.name === "MYSTERY CARD");
  assert.equal(card.startup, false, "an external card is never the startup disk");
  assert.equal(card.mount, null);
  assert.equal(cards.find((c) => c.name === "Macintosh HD").startup, true);
});

// ---- new folders in the destination picker

test("a new folder name is one plain visible segment", () => {
  for (const ok of ["Day 1", "EFJ-261124-RioMinho-FX6-C01-JMY", "Card (2)", "CAMÉRA"]) assert.equal(V.checkFolderName(ok), ok);
  assert.equal(V.checkFolderName("  padded  "), "padded");
  for (const bad of ["", "   ", ".", "..", ".hidden", "a/b", "a\\b", "a:b", "what?", "star*", 'q"', "a<b", "x|y", "end.", "a\u0000b", "x".repeat(121)]) {
    assert.throws(() => V.checkFolderName(bad), undefined, JSON.stringify(bad));
  }
  assert.throws(() => V.checkFolderName(undefined));
});

test("createFolder makes the folder inside the selected drive and nowhere else", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-newfolder-")));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ditcopy-outside-")));
  try {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const entries = [{ filesystem: "/dev/disk9s1", mount: root, totalBytes: 1, usedBytes: 0, availBytes: 1, volumeUuid: uuid }];
    const identity = V.volumeIdentity(uuid);
    const made = V.createFolder(root, "Day 1", root, identity, entries);
    assert.equal(made.created, true);
    assert.ok(fs.statSync(path.join(root, "Day 1")).isDirectory());
    assert.equal(V.createFolder(root, "Day 1", root, identity, entries).created, false, "an existing folder is just used");
    const nested = V.createFolder(path.join(root, "Day 1"), "Card A", root, identity, entries);
    assert.equal(nested.path, path.join(root, "Day 1", "Card A"));
    assert.throws(() => V.createFolder(outside, "x", root, identity, entries), /outside the selected volume/);
    assert.throws(() => V.createFolder(root, "x", root, "volume-uuid:00000000-0000-0000-0000-000000000000", entries), /changed or is unavailable/);
    assert.throws(() => V.createFolder(root, "x", root, identity, entries, { destinationAllowed: false }), /not offered as a destination/);
    fs.writeFileSync(path.join(root, "afile"), "x");
    assert.throws(() => V.createFolder(root, "afile", root, identity, entries), /file named afile already exists/);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing was made outside the drive");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
