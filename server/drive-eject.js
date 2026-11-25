"use strict";

const path = require("path");
const { execFile } = require("child_process");
const volumes = require("./volumes");

function run(command, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout || "";
        error.stderr = stderr || "";
        reject(error);
      } else resolve({ stdout: stdout || "", stderr: stderr || "" });
    });
  });
}

function parseDfMount(output) {
  const rows = String(output || "").trim().split(/\r?\n/);
  if (rows.length < 2) throw new Error("df did not return a mounted filesystem");
  const columns = rows.at(-1).trim().split(/\s+/);
  if (columns.length < 6) throw new Error("could not read the filesystem mount point");
  const mountPoint = columns.slice(5).join(" ");
  if (!mountPoint.startsWith("/")) throw new Error("filesystem mount point is not absolute");
  return mountPoint;
}

function plistValue(xml, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(xml).match(new RegExp(`<key>${escaped}</key>\\s*(?:<(string|integer|real)>([\\s\\S]*?)</\\1>|<(true|false)\\s*/>)`));
  if (!match) return null;
  if (match[3]) return match[3] === "true";
  return match[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function parseDiskInfo(xml, mountPoint) {
  const deviceIdentifier = plistValue(xml, "DeviceIdentifier");
  const wholeDisk = plistValue(xml, "ParentWholeDisk") || String(deviceIdentifier || "").match(/^disk\d+/)?.[0];
  if (!deviceIdentifier || !/^disk\d+(?:s\d+)?$/.test(deviceIdentifier) || !/^disk\d+$/.test(wholeDisk || "")) {
    throw new Error("diskutil did not identify a physical or disk-image device");
  }
  if (plistValue(xml, "Ejectable") !== true) throw new Error("this volume is not marked ejectable by macOS");
  return {
    deviceIdentifier,
    wholeDisk,
    mountPoint: plistValue(xml, "MountPoint") || mountPoint,
    volumeName: plistValue(xml, "VolumeName") || path.basename(mountPoint),
  };
}

function parseMounts(output) {
  const mounts = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const match = line.match(/^(\S+) on (.+?) \(([^)]*)\)$/);
    if (!match) continue;
    const device = path.basename(match[1]);
    const wholeDisk = device.match(/^(disk\d+)/)?.[1];
    if (wholeDisk) mounts.push({ device: match[1], mountPoint: match[2], wholeDisk });
  }
  return mounts;
}

function parseLsof(output) {
  // lsof -F fields: p pid, c command, u user id, f descriptor, a access (r, w, u), t type (REG, DIR), n name.
  const processes = new Map();
  let current = null;
  let file = null;
  for (const line of String(output || "").split(/\r?\n/)) {
    if (line.startsWith("p")) {
      current = { pid: line.slice(1), command: "", uid: null, files: [], details: [] };
      processes.set(current.pid, current);
      file = null;
    } else if (!current) continue;
    else if (line.startsWith("c")) current.command = line.slice(1);
    else if (line.startsWith("u")) current.uid = Number(line.slice(1));
    else if (line.startsWith("f")) file = { access: "", type: "", name: "" };
    else if (line.startsWith("a")) { file = file || { access: "", type: "", name: "" }; file.access = line.slice(1); }
    else if (line.startsWith("t")) { file = file || { access: "", type: "", name: "" }; file.type = line.slice(1); }
    else if (line.startsWith("n")) {
      const record = file && !file.name ? file : { access: "", type: "", name: "" };
      record.name = line.slice(1);
      current.files.push(record.name);
      current.details.push(record);
      file = null;
    }
  }
  return [...processes.values()];
}

// Programs that belong to the system are never offered to be quit. Quitting them can log the person out or hang the Mac.
const SYSTEM_COMMANDS = new Set(["launchd", "kernel_task", "Finder", "mds", "mds_stores", "mdworker", "mdworker_shared", "fseventsd",
  "diskarbitrationd", "coreservicesd", "distnoted", "loginwindow", "Dock", "WindowServer", "revisiond", "backupd", "cloudd", "bird", "fileproviderd"]);
const SYSTEM_PATH = /^\/(System|usr|sbin|bin|Library\/Apple|private\/var\/db)\//;

/** read only folder handle = watcher, read only files = reader, any write = writer. */
function classifyHolder(details) {
  const writes = details.filter((d) => /[wu]/.test(d.access)).length;
  const foldersOnly = details.length > 0 && details.every((d) => d.type === "DIR");
  return { kind: writes ? "writer" : foldersOnly ? "watcher" : "reader", writes };
}

function holderSentence(kind, count, writes) {
  if (kind === "writer") return `is writing ${writes} file${writes === 1 ? "" : "s"} on this drive`;
  if (kind === "watcher") return `has ${count} folder${count === 1 ? "" : "s"} on this drive open, read only, usually to watch for changes`;
  return `is reading ${count} file${count === 1 ? "" : "s"} on this drive`;
}

/**
 * What the person needs to know about each program that holds the drive.
 * canQuit is true only for the person's own, non system programs, never this server or its engine.
 */
function describeBlockers(processes, { executables = new Map(), uid = process.getuid ? process.getuid() : null, selfPids = [process.pid, process.ppid] } = {}) {
  return processes.map((p) => {
    const { kind, writes } = classifyHolder(p.details || []);
    const executable = executables.get(p.pid) || "";
    const app = (executable.match(/([^/]+)\.app\//) || [null, ""])[1];
    const system = SYSTEM_COMMANDS.has(p.command) || SYSTEM_PATH.test(executable);
    const mine = uid != null && Number(p.uid) === uid;
    const self = selfPids.map(String).includes(String(p.pid));
    const canQuit = mine && !system && !self;
    const count = p.files.length;
    return {
      pid: Number(p.pid), command: p.command, app: app || "", executable, kind, writes, openFiles: count,
      samples: p.files.slice(0, 3), canQuit,
      sentence: `${app || p.command || "A program"} (${p.command}, process ${p.pid}) ${holderSentence(kind, count, writes)}`,
      note: canQuit ? "" : self ? "This is DitCopy itself." : system ? "A macOS system program: wait a moment and try again." : "Owned by another user.",
    };
  });
}

/** Thrown when programs hold the drive. Carries what is needed to show the person their choices. */
class BlockedError extends Error {
  constructor(message, blockers) {
    super(message);
    this.name = "BlockedError";
    this.blockers = blockers;
    // Forcing the unmount is only offered when nothing is writing, so no data can be lost by it.
    this.forceAllowed = blockers.length > 0 && blockers.every((b) => b.kind !== "writer");
  }
}

function busyReason(processes, mountPoint) {
  if (!processes.length) return null;
  return processes
    .map((p) => `${p.command || "process"} (PID ${p.pid}) [${p.files.slice(0, 3).join(", ")}]`)
    .join(", ") + ` still has ${processes.reduce((n, p) => n + p.files.length, 0)} open file(s) on ${mountPoint}`;
}

function createDriveEjectService(runCommand = run, locatePath = volumes.locateVolumeForPath,
  { kill = (pid, signal) => process.kill(pid, signal), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), quitWaitMs = 8000, identity = {} } = {}) {
  async function mountPointForPath(inputPath) {
    if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) throw new Error("drive path must be absolute");
    const volume = await locatePath(inputPath);
    if (!volume) throw new Error(`no mounted filesystem for ${inputPath}`);
    return volume.mountPoint;
  }

  async function inspect(inputPath) {
    if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) throw new Error("drive path must be absolute");
    const resolved = path.resolve(inputPath);
    const mountPoint = await mountPointForPath(resolved);
    if (mountPoint === "/") throw new Error("refusing to eject the startup disk");
    const info = await runCommand("diskutil", ["info", "-plist", mountPoint]);
    const drive = parseDiskInfo(info.stdout, mountPoint);
    const mountResult = await runCommand("mount", []);
    const mountPoints = parseMounts(mountResult.stdout)
      .filter((m) => m.wholeDisk === drive.wholeDisk)
      .map((m) => m.mountPoint);
    if (!mountPoints.includes(drive.mountPoint)) mountPoints.push(drive.mountPoint);
    return { ...drive, mountPoints };
  }

  async function gatherBlockers(drive) {
    const found = [];
    for (const mountPoint of drive.mountPoints) {
      let result;
      try {
        result = await runCommand("lsof", ["-nP", "-Fpcuftan", "+D", mountPoint], 60000);
      } catch (error) {
        if (String(error.stdout || "").trim()) result = { stdout: error.stdout };
        else if (error.code === 1 && !String(error.stderr || "").trim()) result = { stdout: "" };
        else throw new Error(`could not check open files on ${mountPoint}: ${String(error.stderr || error.message).trim()}`);
      }
      for (const p of parseLsof(result.stdout)) found.push({ ...p, mountPoint });
    }
    const executables = new Map();
    for (const p of found) {
      try {
        const out = await runCommand("ps", ["-p", p.pid, "-o", "comm="]);
        executables.set(p.pid, String(out.stdout || "").trim());
      } catch {
        /* the program name is a nicety, never a reason to fail */
      }
    }
    return { processes: found, blockers: describeBlockers(found, { executables, ...identity }) };
  }

  const waitForExit = async (drive, firstPids) => {
    for (let waited = 0; waited < quitWaitMs; waited += 500) {
      await sleep(500);
      const now = await gatherBlockers(drive);
      if (!now.blockers.length) return now;
    }
    const now = await gatherBlockers(drive);
    // A program that comes back under a new process number started itself again, like a login item.
    now.blockers.forEach((b) => { if (!firstPids.has(String(b.pid))) b.restarted = true; });
    return now;
  };

  /**
   * resolve: undefined = refuse and report who holds the drive. "quit" = ask the person's own programs to quit, wait,
   * look again. "force" = unmount even though programs hold it, allowed only when nothing is writing.
   */
  async function eject(inputPath, { resolve } = {}) {
    const drive = await inspect(inputPath);
    let held = await gatherBlockers(drive);
    let forced = false;
    if (held.blockers.length) {
      if (resolve === "quit") {
        const targets = held.blockers.filter((b) => b.canQuit);
        if (!targets.length) throw new BlockedError(busyReason(held.processes, drive.mountPoint), held.blockers);
        const firstPids = new Set(held.blockers.map((b) => String(b.pid)));
        for (const b of targets) {
          try { kill(b.pid, "SIGTERM"); } catch { /* already gone */ }
        }
        held = await waitForExit(drive, firstPids);
      }
      if (held.blockers.length && resolve === "force") {
        if (held.blockers.some((b) => b.kind === "writer")) {
          throw new BlockedError(`${held.blockers.find((b) => b.kind === "writer").sentence}. Quit that program first, forcing now could lose its data.`, held.blockers);
        }
        forced = true;
      } else if (held.blockers.length) {
        throw new BlockedError(busyReason(held.processes, drive.mountPoint), held.blockers);
      }
    }

    try {
      if (forced) await runCommand("diskutil", ["unmountDisk", "force", drive.wholeDisk], 60000);
      await runCommand("diskutil", ["eject", drive.wholeDisk], 60000);
    } catch (error) {
      const details = String(error.stderr || error.stdout || error.message).trim();
      throw new Error(`macOS refused to eject ${drive.wholeDisk}: ${details}`);
    }
    const after = await runCommand("mount", []);
    const stillMounted = parseMounts(after.stdout).filter((m) => m.wholeDisk === drive.wholeDisk);
    if (stillMounted.length) {
      throw new Error(`macOS reported eject for ${drive.wholeDisk}, but it remains mounted at ${stillMounted.map((m) => m.mountPoint).join(", ")}`);
    }
    return { ...drive, state: "safe", message: forced ? "Safe to unplug (a read only program was holding it, the unmount was forced)" : "Safe to unplug" };
  }

  return { eject, inspect, mountPointForPath };
}

module.exports = { BlockedError, busyReason, classifyHolder, createDriveEjectService, describeBlockers, parseDfMount, parseDiskInfo, parseLsof, parseMounts };
