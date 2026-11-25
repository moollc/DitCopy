"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  busyReason,
  createDriveEjectService,
  parseDfMount,
  parseDiskInfo,
  parseLsof,
  parseMounts,
} = require("./drive-eject");

const info = `<?xml version="1.0"?><plist><dict>
<key>DeviceIdentifier</key><string>disk7s1</string>
<key>ParentWholeDisk</key><string>disk7</string>
<key>MountPoint</key><string>/tmp/ditcopy-test-b4p2/drive</string>
<key>VolumeName</key><string>DitCopy Test</string>
<key>Ejectable</key><true/>
</dict></plist>`;

test("drive parsers retain mount paths with spaces and identify sibling volumes", () => {
  assert.equal(parseDfMount("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk7s1 200000 100 199900 1% /tmp/ditcopy-test-b4p2/drive"), "/tmp/ditcopy-test-b4p2/drive");
  assert.deepEqual(parseDiskInfo(info, "/tmp/ditcopy-test-b4p2/drive"), {
    deviceIdentifier: "disk7s1", wholeDisk: "disk7", mountPoint: "/tmp/ditcopy-test-b4p2/drive", volumeName: "DitCopy Test",
  });
  assert.deepEqual(parseMounts("/dev/disk7s1 on /tmp/ditcopy-test-b4p2/drive (hfs, local, nodev)\n/dev/disk8s1 on /Volumes/Other (apfs, local)"), [
    { device: "/dev/disk7s1", mountPoint: "/tmp/ditcopy-test-b4p2/drive", wholeDisk: "disk7" },
    { device: "/dev/disk8s1", mountPoint: "/Volumes/Other", wholeDisk: "disk8" },
  ]);
});

test("lsof process records name, pid and open file paths for a useful busy reason", () => {
  const processes = parseLsof("p4321\ncnode\nn/tmp/ditcopy-test-b4p2/drive/held-open.bin\np987\ncPreview\nn/tmp/ditcopy-test-b4p2/drive/other.bin");
  assert.equal(processes.length, 2);
  assert.match(busyReason(processes, "/tmp/ditcopy-test-b4p2/drive"), /node \(PID 4321\).*2 open file\(s\)/);
});

test("eject checks every mounted volume, asks diskutil to eject the whole disk and confirms unmount", async () => {
  const calls = [];
  let ejectRequested = false;
  const fakeRun = async (command, args) => {
    calls.push([command, args]);
    if (command === "df") return { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk7s1 200000 100 199900 1% /tmp/ditcopy-test-b4p2/drive" };
    if (command === "diskutil" && args[0] === "info") return { stdout: info };
    if (command === "mount") return { stdout: ejectRequested ? "" : "/dev/disk7s1 on /tmp/ditcopy-test-b4p2/drive (hfs, local)\n/dev/disk7s2 on /tmp/ditcopy-test-b4p2/other (hfs, local)" };
    if (command === "lsof") { const error = new Error("no open files"); error.code = 1; error.stderr = ""; throw error; }
    if (command === "diskutil" && args[0] === "eject") { ejectRequested = true; return { stdout: "" }; }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  const locate = async () => ({ mountPoint: "/tmp/ditcopy-test-b4p2/drive" });
  const result = await createDriveEjectService(fakeRun, locate).eject("/tmp/ditcopy-test-b4p2/drive/output");
  assert.equal(result.state, "safe");
  assert.deepEqual(result.mountPoints, ["/tmp/ditcopy-test-b4p2/drive", "/tmp/ditcopy-test-b4p2/other"]);
  assert.ok(calls.some(([command, args]) => command === "diskutil" && args[0] === "eject" && args[1] === "disk7"));
  assert.equal(calls.some(([command]) => command === "df"), false);
  assert.equal(calls.filter(([command]) => command === "lsof").length, 2);
});

test("eject is refused with the blocking process before diskutil is called", async () => {
  const calls = [];
  const fakeRun = async (command, args) => {
    calls.push([command, args]);
    if (command === "df") return { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk7s1 200000 100 199900 1% /tmp/ditcopy-test-b4p2/drive" };
    if (command === "diskutil") return { stdout: info };
    if (command === "mount") return { stdout: "/dev/disk7s1 on /tmp/ditcopy-test-b4p2/drive (hfs, local)" };
    if (command === "lsof") {
      const error = new Error("lsof returned partial results");
      error.code = 1;
      error.stdout = "p4321\ncnode\nn/tmp/ditcopy-test-b4p2/drive/held-open.bin";
      error.stderr = "";
      throw error;
    }
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  await assert.rejects(createDriveEjectService(fakeRun, async () => ({ mountPoint: "/tmp/ditcopy-test-b4p2/drive" })).eject("/tmp/ditcopy-test-b4p2/drive"), /node \(PID 4321\).*held-open/);
  assert.equal(calls.some(([command, args]) => command === "diskutil" && args[0] === "eject"), false);
});

test("startup disk and non-ejectable volumes are refused", async () => {
  const rootService = createDriveEjectService(async () => {
    throw new Error("should not inspect the startup disk");
  }, async () => ({ mountPoint: "/" }));
  await assert.rejects(rootService.inspect("/"), /startup disk/);
  const fixedInfo = info.replace("<key>Ejectable</key><true/>", "<key>Ejectable</key><false/>");
  const fixedService = createDriveEjectService(async (command) => {
    if (command === "diskutil") return { stdout: fixedInfo };
    throw new Error("should refuse before ejecting");
  }, async () => ({ mountPoint: "/tmp/ditcopy-test-b4p2/drive" }));
  await assert.rejects(fixedService.inspect("/tmp/ditcopy-test-b4p2/drive"), /not marked ejectable/);
});

// ---- blockers: who holds the drive, and the choices offered

const { BlockedError, classifyHolder, describeBlockers } = require("./drive-eject");

// lsof -F output: p pid, c command, u user id, f descriptor, a access, t type, n name
const lsofText = (...procs) => procs.map((p) => `p${p.pid}\nc${p.command}\nu${p.uid ?? 501}\n` + p.files.map((f) => `f${f.fd || "22"}\na${f.access || "r"}\nt${f.type || "REG"}\nn${f.name}`).join("\n")).join("\n");
const watcher = { pid: 829, command: "sampled", uid: 501, files: [{ type: "DIR", name: "/tmp/ditcopy-test-b4p2/drive" }] };

test("lsof fields give access and type, and a holder is a watcher, reader or writer", () => {
  const [p] = parseLsof(lsofText(watcher));
  assert.equal(p.uid, 501);
  assert.deepEqual(p.details[0], { access: "r", type: "DIR", name: "/tmp/ditcopy-test-b4p2/drive" });
  assert.equal(classifyHolder(p.details).kind, "watcher");
  assert.equal(classifyHolder([{ access: "r", type: "REG", name: "x" }]).kind, "reader");
  assert.equal(classifyHolder([{ access: "r", type: "REG", name: "x" }, { access: "u", type: "REG", name: "y" }]).kind, "writer");
  assert.equal(classifyHolder([{ access: "w", type: "REG", name: "y" }]).writes, 1);
});

test("only the person's own, non system programs can be quit, never DitCopy itself", () => {
  const procs = parseLsof(lsofText(
    watcher,
    { pid: 50, command: "mds", uid: 0, files: [{ type: "DIR", name: "/x" }] },
    { pid: 51, command: "Finder", uid: 501, files: [{ type: "DIR", name: "/x" }] },
    { pid: 52, command: "other", uid: 502, files: [{ name: "/x/a" }] },
    { pid: 4000, command: "node", uid: 501, files: [{ name: "/x/log" }] },
  ));
  const executables = new Map([["829", "/Users/dit/Applications/Sample.app/Contents/MacOS/sampled"], ["50", "/System/Library/CoreServices/mds"]]);
  const blockers = describeBlockers(procs, { executables, uid: 501, selfPids: [4000] });
  const byPid = Object.fromEntries(blockers.map((b) => [b.pid, b]));
  assert.equal(byPid[829].canQuit, true);
  assert.equal(byPid[829].app, "Sample");
  assert.match(byPid[829].sentence, /Sample \(sampled, process 829\) has 1 folder on this drive open, read only/);
  assert.equal(byPid[50].canQuit, false);
  assert.equal(byPid[51].canQuit, false, "Finder is a system program");
  assert.equal(byPid[52].canQuit, false, "another user");
  assert.equal(byPid[4000].canQuit, false, "this server");
  assert.match(byPid[4000].note, /DitCopy itself/);
});

function ejectRig({ lsofRounds, kills = [], calls = [] }) {
  let round = 0;
  const run = async (command, args) => {
    calls.push([command, args]);
    if (command === "diskutil" && args[0] === "info") return { stdout: info };
    if (command === "mount") return { stdout: calls.some(([c, a]) => c === "diskutil" && a[0] === "eject") ? "" : "/dev/disk7s1 on /tmp/ditcopy-test-b4p2/drive (hfs, local)" };
    if (command === "lsof") {
      const text = lsofRounds[Math.min(round++, lsofRounds.length - 1)];
      if (!text) { const e = new Error("none"); e.code = 1; e.stderr = ""; throw e; }
      const e = new Error("partial"); e.code = 1; e.stdout = text; e.stderr = ""; throw e;
    }
    if (command === "ps") return { stdout: "/Users/dit/Applications/Sample.app/Contents/MacOS/sampled\n" };
    if (command === "diskutil") return { stdout: "" };
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
  const service = createDriveEjectService(run, async () => ({ mountPoint: "/tmp/ditcopy-test-b4p2/drive" }), {
    kill: (pid, signal) => kills.push([pid, signal]), sleep: async () => {}, quitWaitMs: 1000, identity: { uid: 501, selfPids: [1] },
  });
  return { service, kills, calls };
}

test("a blocked eject reports the blockers and offers force when nothing writes", async () => {
  const { service, calls } = ejectRig({ lsofRounds: [lsofText(watcher)] });
  await assert.rejects(service.eject("/tmp/ditcopy-test-b4p2/drive"), (e) => {
    assert.ok(e instanceof BlockedError);
    assert.equal(e.blockers.length, 1);
    assert.equal(e.blockers[0].kind, "watcher");
    assert.equal(e.forceAllowed, true);
    assert.match(e.message, /sampled \(PID 829\)/);
    return true;
  });
  assert.equal(calls.some(([c, a]) => c === "diskutil" && a[0] === "eject"), false);
});

test("quit asks only the quittable programs to close, waits, and ejects once the drive is free", async () => {
  const { service, kills, calls } = ejectRig({ lsofRounds: [lsofText(watcher, { pid: 50, command: "mds", uid: 0, files: [{ type: "DIR", name: "/x" }] })] });
  // the system program stays, so the eject must still be refused, and mds was never signaled
  await assert.rejects(service.eject("/tmp/ditcopy-test-b4p2/drive", { resolve: "quit" }), BlockedError);
  assert.deepEqual(kills, [[829, "SIGTERM"]]);
  assert.equal(calls.some(([c, a]) => c === "diskutil" && a[0] === "eject"), false);
  // with only the watcher, quitting frees the drive and the eject goes through
  const rig = ejectRig({ lsofRounds: [lsofText(watcher), ""] });
  const result = await rig.service.eject("/tmp/ditcopy-test-b4p2/drive", { resolve: "quit" });
  assert.equal(result.state, "safe");
  assert.deepEqual(rig.kills, [[829, "SIGTERM"]]);
});

test("a program that starts itself again is reported as restarted", async () => {
  const again = { ...watcher, pid: 9001 };
  const { service } = ejectRig({ lsofRounds: [lsofText(watcher), lsofText(again), lsofText(again), lsofText(again)] });
  await assert.rejects(service.eject("/tmp/ditcopy-test-b4p2/drive", { resolve: "quit" }), (e) => {
    assert.equal(e.blockers[0].restarted, true);
    assert.equal(e.forceAllowed, true);
    return true;
  });
});

test("force unmounts when only watchers hold the drive, and refuses when anything writes", async () => {
  const rig = ejectRig({ lsofRounds: [lsofText(watcher)] });
  const result = await rig.service.eject("/tmp/ditcopy-test-b4p2/drive", { resolve: "force" });
  assert.equal(result.state, "safe");
  assert.match(result.message, /forced/);
  const order = rig.calls.filter(([c, a]) => c === "diskutil" && ["unmountDisk", "eject"].includes(a[0])).map(([, a]) => a.join(" "));
  assert.deepEqual(order, ["unmountDisk force disk7", "eject disk7"]);

  const writer = { pid: 77, command: "Premiere", uid: 501, files: [{ access: "u", type: "REG", name: "/tmp/ditcopy-test-b4p2/drive/cache.pek" }] };
  const rig2 = ejectRig({ lsofRounds: [lsofText(watcher, writer)] });
  await assert.rejects(rig2.service.eject("/tmp/ditcopy-test-b4p2/drive", { resolve: "force" }), (e) => {
    assert.equal(e.forceAllowed, false);
    assert.match(e.message, /is writing 1 file/);
    return true;
  });
  assert.equal(rig2.calls.some(([c, a]) => c === "diskutil" && a[0] === "unmountDisk"), false, "never forced while a program writes");
});

test("a drive that is already ejected says it is not mounted, not that it is the startup disk", { skip: process.platform !== "darwin" && "eject is macOS only" }, async () => {
  const service = createDriveEjectService(async () => { throw new Error("should not run any command"); }, async () => ({ mountPoint: "/" }));
  await assert.rejects(service.inspect("/Volumes/DitCopyTestDriveThatIsNotMounted/EFJ"), /is not mounted, it may already be ejected/);
});
