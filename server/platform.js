"use strict";
// Everything that differs between macOS, Linux and Windows lives here, so the rest of the server asks questions
// ("which mounts exist", "is this path on an external drive", "keep the machine awake") and never checks the OS itself.
// Every function takes the platform as an argument (default: this machine) so tests can run all three on any machine.
const fs = require("node:fs");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");

// "darwin" | "linux" | "win32". DITCOPY_PLATFORM is a test hook so the macOS fixtures run the macOS rules on any machine.
const HERE = ["darwin", "linux", "win32"].includes(process.env.DITCOPY_PLATFORM) ? process.env.DITCOPY_PLATFORM : process.platform;

const isWin = (platform = HERE) => platform === "win32";

/** Name of the engine program for this OS. */
function engineFileName(platform = HERE) {
  return isWin(platform) ? "ditcopy_engine.exe" : "ditcopy_engine";
}

/** The engine program: next to a source build (engine/target/release) or in a packaged copy (engine/). */
function defaultEnginePath(root, platform = HERE) {
  const name = engineFileName(platform);
  const candidates = [path.join(root, "engine", "target", "release", name), path.join(root, "engine", name)];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

/** A downloaded copy carries bundle.json. It may sit in a folder the person cannot write to, so it keeps its data elsewhere. */
function isBundled(root) {
  return fs.existsSync(path.join(root, "bundle.json"));
}

/** Where logs, saved jobs and reports live. DITCOPY_DATA overrides. A source checkout keeps them in its own folder. */
function dataDir(root, env = process.env, platform = HERE) {
  if (env.DITCOPY_DATA) return env.DITCOPY_DATA;
  if (!isBundled(root)) return root;
  const home = env.HOME || env.USERPROFILE || require("node:os").homedir();
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "DitCopy");
  if (isWin(platform)) return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "DitCopy");
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "ditcopy");
}

/** Mounts that belong to the running system, never offered as a copy destination. */
function startupMounts(platform = HERE, env = process.env) {
  if (platform === "darwin") return new Set(["/", "/System/Volumes/Data"]);
  if (isWin(platform)) return new Set([`${String(env.SystemDrive || "C:").toUpperCase()}\\`]);
  return new Set(["/"]);
}

/** Directories whose sub folders are the mount points of removable drives. */
function mountParents(platform = HERE, env = process.env) {
  if (platform === "darwin") return ["/Volumes"];
  if (isWin(platform)) return [];
  const user = env.USER || env.LOGNAME || "";
  return [user && `/run/media/${user}`, user && `/media/${user}`, "/media", "/mnt"].filter(Boolean);
}

/**
 * The mount point that holds this path when it is on an external drive, else null.
 * macOS: /Volumes/<name>. Linux: /media, /run/media or /mnt. Windows: a drive letter other than the system drive.
 */
function externalMountOf(p, platform = HERE, env = process.env) {
  const text = String(p || "");
  if (platform === "darwin") return (text.match(/^\/Volumes\/[^/]+/) || [null])[0];
  if (isWin(platform)) {
    const m = text.match(/^([A-Za-z]):[\\/]?/);
    if (!m) return null;
    const root = `${m[1].toUpperCase()}:\\`;
    return startupMounts(platform, env).has(root) ? null : root;
  }
  const m = text.match(/^(\/run\/media\/[^/]+\/[^/]+|\/media\/[^/]+\/[^/]+|\/media\/[^/]+|\/mnt\/[^/]+)/);
  return m ? m[1] : null;
}

/** True when `real` is the mount itself or inside it. Windows paths compare without regard to case. */
function insideMount(real, mount, platform = HERE) {
  // NFC first: macOS can spell an accented name two ways (e and an accent, or one accented letter), and the two must match.
  const a = isWin(platform) ? String(real).normalize("NFC").toLowerCase() : String(real).normalize("NFC");
  const b = isWin(platform) ? String(mount).normalize("NFC").toLowerCase() : String(mount).normalize("NFC");
  const sep = isWin(platform) ? "\\" : "/";
  const base = b.endsWith(sep) ? b : b + sep;
  return a === b || a === base.slice(0, -1) || a.startsWith(base);
}

/** A key for "the same physical disk" taken from a filesystem name. It is only a hint, never proof. */
function diskKey(filesystem, platform = HERE) {
  const text = String(filesystem || "");
  if (platform === "darwin") return (text.match(/\/dev\/(disk\d+)/) || [null, null])[1];
  if (isWin(platform)) return null;
  const nvme = text.match(/^\/dev\/(nvme\d+n\d+)(?:p\d+)?$/);
  if (nvme) return nvme[1];
  const mmc = text.match(/^\/dev\/(mmcblk\d+)(?:p\d+)?$/);
  if (mmc) return mmc[1];
  const sd = text.match(/^\/dev\/((?:sd|vd|xvd|hd)[a-z]+)\d*$/);
  return sd ? sd[1] : null;
}

// ---- Linux: a volume UUID per mount point, from `findmnt -rn -o TARGET,UUID`

function unescapeFindmnt(text) {
  return String(text).replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** Map of mount point to lower case UUID. Lines without a UUID (pseudo filesystems) are skipped. */
function parseFindmnt(output) {
  const map = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+([0-9A-Fa-f][0-9A-Fa-f-]{6,})$/);
    if (m) map.set(unescapeFindmnt(m[1]), m[2].toLowerCase());
  }
  return map;
}

// ---- Windows: volumes from PowerShell (Win32_Volume as JSON)

const WIN_VOLUME_SCRIPT =
  "Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter } | " +
  "Select-Object DriveLetter,Label,Capacity,FreeSpace,DeviceID,FileSystem | ConvertTo-Json -Compress";

/** DeviceID looks like \\?\Volume{GUID}\ . The GUID is the stable identity. */
function parseWinVolumes(json) {
  let rows;
  try {
    rows = JSON.parse(String(json || "").trim() || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows];
  return rows
    .filter((r) => r && r.DriveLetter)
    .map((r) => {
      const guid = String(r.DeviceID || "").match(/\{([0-9a-fA-F-]{36})\}/);
      const total = Number(r.Capacity) || 0;
      const free = Number(r.FreeSpace) || 0;
      return {
        filesystem: String(r.DeviceID || r.DriveLetter),
        totalBytes: total,
        usedBytes: Math.max(0, total - free),
        availBytes: free,
        mount: `${String(r.DriveLetter).toUpperCase().replace(/:$/, "")}:\\`,
        label: r.Label || "",
        volumeUuid: guid ? guid[1].toLowerCase() : null,
      };
    });
}

function runText(file, args, options = {}, run = execFile) {
  return new Promise((resolve) => {
    run(file, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 30000, ...options }, (err, stdout) => resolve(err ? "" : stdout));
  });
}

/** Mounted volumes on Windows. Linux and macOS are read with df in volumes.js. */
async function loadWindowsVolumes(run = execFile) {
  const out = await runText("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WIN_VOLUME_SCRIPT], {}, run);
  return parseWinVolumes(out);
}

/** On Linux: mount point to UUID. */
async function loadLinuxUuids(run = execFile) {
  return parseFindmnt(await runText("findmnt", ["-rn", "-o", "TARGET,UUID"], {}, run));
}

// ---- keep the machine awake while a copy runs

/** Command and arguments that hold the machine awake until the child is killed, or null when this OS has no such tool here. */
function keepAwakeCommand(platform = HERE) {
  if (platform === "darwin") return { file: "caffeinate", args: ["-i"] };
  if (isWin(platform)) {
    const script =
      "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
      "while ($true) { [W.P]::SetThreadExecutionState(0x80000001) | Out-Null; Start-Sleep -Seconds 30 }";
    return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { file: "systemd-inhibit", args: ["--what=idle:sleep", "--who=DitCopy", "--why=Copy in progress", "sleep", "infinity"] };
}

/** Starts the keep awake child. Returns it, or null when the tool is missing (the copy is never blocked by this). */
function startKeepAwake(platform = HERE, spawnFn = spawn) {
  const cmd = keepAwakeCommand(platform);
  if (!cmd) return null;
  try {
    const child = spawnFn(cmd.file, cmd.args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.on("error", () => {});
    return child;
  } catch {
    return null;
  }
}

// ---- features that exist on some systems only

/** Eject and USB link speed read macOS tools. Elsewhere the page says so instead of showing broken buttons. */
function capabilities(platform = HERE) {
  const mac = platform === "darwin";
  return {
    platform,
    eject: mac,
    ejectReason: mac ? "" : "Eject is available on macOS. Use your file manager to unmount drives on this system.",
    linkSpeed: mac,
    uncachedProbe: mac || platform === "linux",
  };
}

/** Opens a folder in Finder, Explorer or the file manager. */
function revealCommand(folder, platform = HERE) {
  if (platform === "darwin") return { file: "open", args: [folder] };
  if (isWin(platform)) return { file: "explorer.exe", args: [folder] };
  return { file: "xdg-open", args: [folder] };
}

/** Opens a page in the default browser. */
function openCommand(url, platform = HERE) {
  if (platform === "darwin") return { file: "open", args: [url] };
  if (isWin(platform)) return { file: "cmd.exe", args: ["/c", "start", "", url] };
  return { file: "xdg-open", args: [url] };
}

module.exports = {
  HERE,
  engineFileName,
  defaultEnginePath,
  isBundled,
  dataDir,
  startupMounts,
  mountParents,
  externalMountOf,
  insideMount,
  diskKey,
  parseFindmnt,
  parseWinVolumes,
  loadWindowsVolumes,
  loadLinuxUuids,
  keepAwakeCommand,
  startKeepAwake,
  capabilities,
  openCommand,
  revealCommand,
  fileExists: (p) => fs.existsSync(p),
  sep: path.sep,
};
