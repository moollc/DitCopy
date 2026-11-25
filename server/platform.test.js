"use strict";
// Run: node --test server/platform.test.js
// Linux and Windows behaviour is tested with fixed sample output, so it is checked on every machine and in CI.
const test = require("node:test");
const assert = require("node:assert");
const P = require("./platform");

const linuxEnv = { USER: "dit" };
const winEnv = { SystemDrive: "C:" };

test("the engine file name follows the OS", () => {
  assert.strictEqual(P.engineFileName("darwin"), "ditcopy_engine");
  assert.strictEqual(P.engineFileName("linux"), "ditcopy_engine");
  assert.strictEqual(P.engineFileName("win32"), "ditcopy_engine.exe");
});

test("startup mounts are never offered as destinations", () => {
  assert.deepStrictEqual([...P.startupMounts("darwin")], ["/", "/System/Volumes/Data"]);
  assert.deepStrictEqual([...P.startupMounts("linux")], ["/"]);
  assert.deepStrictEqual([...P.startupMounts("win32", winEnv)], ["C:\\"]);
});

test("external mounts are found per system", () => {
  assert.strictEqual(P.externalMountOf("/Volumes/Kane/EFJ/VID", "darwin"), "/Volumes/Kane");
  assert.strictEqual(P.externalMountOf("/Users/x/Desktop", "darwin"), null);
  assert.strictEqual(P.externalMountOf("/media/dit/CARD01/PRIVATE", "linux", linuxEnv), "/media/dit/CARD01");
  assert.strictEqual(P.externalMountOf("/run/media/dit/CARD01/x", "linux", linuxEnv), "/run/media/dit/CARD01");
  assert.strictEqual(P.externalMountOf("/mnt/raid/shoot", "linux", linuxEnv), "/mnt/raid");
  assert.strictEqual(P.externalMountOf("/home/dit/Documents", "linux", linuxEnv), null);
  assert.strictEqual(P.externalMountOf("D:\\EFJ\\VID", "win32", winEnv), "D:\\");
  assert.strictEqual(P.externalMountOf("d:/EFJ", "win32", winEnv), "D:\\");
  assert.strictEqual(P.externalMountOf("C:\\Users\\dit", "win32", winEnv), null);
});

test("a path is inside a mount, with Windows case and separator rules", () => {
  assert.ok(P.insideMount("/Volumes/Kane/a", "/Volumes/Kane", "darwin"));
  assert.ok(P.insideMount("/Volumes/Kane", "/Volumes/Kane", "darwin"));
  assert.ok(!P.insideMount("/Volumes/Kane2/a", "/Volumes/Kane", "darwin"));
  assert.ok(P.insideMount("/anything", "/", "linux"));
  assert.ok(P.insideMount("D:\\EFJ\\VID", "D:\\", "win32"));
  assert.ok(P.insideMount("d:\\efj", "D:\\", "win32"));
  assert.ok(!P.insideMount("E:\\EFJ", "D:\\", "win32"));
});

test("the disk key groups partitions of one physical disk on Linux", () => {
  assert.strictEqual(P.diskKey("/dev/disk5s1", "darwin"), "disk5");
  assert.strictEqual(P.diskKey("/dev/sdb1", "linux"), "sdb");
  assert.strictEqual(P.diskKey("/dev/sdb2", "linux"), "sdb");
  assert.strictEqual(P.diskKey("/dev/nvme0n1p3", "linux"), "nvme0n1");
  assert.strictEqual(P.diskKey("/dev/mmcblk0p1", "linux"), "mmcblk0");
  assert.strictEqual(P.diskKey("tmpfs", "linux"), null);
  assert.strictEqual(P.diskKey("\\\\?\\Volume{abc}\\", "win32"), null);
});

test("findmnt output becomes a mount to UUID map, with escaped spaces and no pseudo filesystems", () => {
  const out = [
    "/ 6f1c2a9e-8d3b-4b4e-9a55-1c2d3e4f5a6b",
    "/media/dit/FX6\\x20CARD 4C8D-466C",
    "/run/media/dit/KANE 4c8d466c-6592-3d45-89fe-f62e3bdad870",
    "/proc",
    "/sys/fs/cgroup",
  ].join("\n");
  const map = P.parseFindmnt(out);
  assert.strictEqual(map.get("/"), "6f1c2a9e-8d3b-4b4e-9a55-1c2d3e4f5a6b");
  assert.strictEqual(map.get("/media/dit/FX6 CARD"), "4c8d-466c");
  assert.strictEqual(map.get("/run/media/dit/KANE"), "4c8d466c-6592-3d45-89fe-f62e3bdad870");
  assert.strictEqual(map.has("/proc"), false);
});

test("Windows volumes come from PowerShell JSON, one object or several", () => {
  const several = JSON.stringify([
    { DriveLetter: "C:", Label: "OS", Capacity: 500000000000, FreeSpace: 100000000000, DeviceID: "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\", FileSystem: "NTFS" },
    { DriveLetter: "D:", Label: "KANE", Capacity: 2000000000000, FreeSpace: 74000000000, DeviceID: "\\\\?\\Volume{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}\\", FileSystem: "exFAT" },
  ]);
  const rows = P.parseWinVolumes(several);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1].mount, "D:\\");
  assert.strictEqual(rows[1].label, "KANE");
  assert.strictEqual(rows[1].volumeUuid, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  assert.strictEqual(rows[1].availBytes, 74000000000);
  assert.strictEqual(rows[1].usedBytes, 2000000000000 - 74000000000);
  const one = P.parseWinVolumes(JSON.stringify({ DriveLetter: "E:", Label: "", Capacity: 10, FreeSpace: 4, DeviceID: "\\\\?\\Volume{99999999-8888-7777-6666-555555555555}\\" }));
  assert.strictEqual(one.length, 1);
  assert.strictEqual(one[0].mount, "E:\\");
  assert.deepStrictEqual(P.parseWinVolumes("not json"), []);
  assert.deepStrictEqual(P.parseWinVolumes(""), []);
});

test("keep awake picks the right tool per system", () => {
  assert.strictEqual(P.keepAwakeCommand("darwin").file, "caffeinate");
  assert.strictEqual(P.keepAwakeCommand("linux").file, "systemd-inhibit");
  assert.strictEqual(P.keepAwakeCommand("win32").file, "powershell.exe");
  assert.match(P.keepAwakeCommand("win32").args.join(" "), /SetThreadExecutionState/);
});

test("a missing keep awake tool never throws", () => {
  const child = P.startKeepAwake("linux", () => { throw new Error("spawn failed"); });
  assert.strictEqual(child, null);
});

test("eject and link speed are macOS only, the page is told why", () => {
  assert.strictEqual(P.capabilities("darwin").eject, true);
  const lin = P.capabilities("linux");
  assert.strictEqual(lin.eject, false);
  assert.match(lin.ejectReason, /file manager/);
  assert.strictEqual(lin.uncachedProbe, true);
  assert.strictEqual(P.capabilities("win32").uncachedProbe, false);
});

test("the browser opens with the system command", () => {
  assert.deepStrictEqual(P.openCommand("http://x", "darwin"), { file: "open", args: ["http://x"] });
  assert.strictEqual(P.openCommand("http://x", "linux").file, "xdg-open");
  assert.deepStrictEqual(P.openCommand("http://x", "win32").args, ["/c", "start", "", "http://x"]);
});
