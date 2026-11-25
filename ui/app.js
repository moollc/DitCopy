(() => {
  "use strict";

  const DESTRUCTIVE = new Set(["sync", "move", "delete"]);

  const el = {
    src: document.getElementById("src"),
    dest: document.getElementById("dest"),
    mode: document.getElementById("mode"),
    hash: document.getElementById("hash"),
    speed: document.getElementById("speed"),
    verify: document.getElementById("verify"),
    perfectVerify: document.getElementById("perfect-verify"),
    nonstop: document.getElementById("nonstop"),
    cascade: document.getElementById("cascade"),
    writeMhl: document.getElementById("write-mhl"),
    writeReport: document.getElementById("write-report"),
    keepAwake: document.getElementById("keep-awake"),
    testDriveSpeed: document.getElementById("test-drive-speed"),
    cooldownSeconds: document.getElementById("cooldown-seconds"),
    cooldownEveryGb: document.getElementById("cooldown-every-gb"),
    cooldownDropPercent: document.getElementById("cooldown-drop-percent"),
    include: document.getElementById("include"),
    exclude: document.getElementById("exclude"),
    minSize: document.getElementById("min-size"),
    maxSize: document.getElementById("max-size"),
    fromDate: document.getElementById("from-date"),
    toDate: document.getElementById("to-date"),
    preset: document.getElementById("preset"),
    jobName: document.getElementById("job-name"),
    save: document.getElementById("btn-save"),
    run: document.getElementById("btn-run"),
    cancel: document.getElementById("btn-cancel"),
    pause: document.getElementById("btn-pause"),
    stop: document.getElementById("btn-stop"),
    resume: document.getElementById("btn-resume"),
    retryFailed: document.getElementById("btn-retry-failed"),
    volumesBtn: document.getElementById("btn-volumes"),
    volumes: document.getElementById("volumes"),
    driveActions: document.getElementById("drive-actions"),
    checkBody: document.getElementById("check-body"),
    picker: document.getElementById("picker"),
    pickerTitle: document.getElementById("picker-title"),
    pickerPath: document.getElementById("picker-path"),
    pickerList: document.getElementById("picker-list"),
    pickerUp: document.getElementById("picker-up"),
    pickerSource: document.getElementById("picker-source"),
    pickerDest: document.getElementById("picker-dest"),
    pickerClose: document.getElementById("picker-close"),
    pickerNote: document.getElementById("picker-note"),
    health: document.getElementById("health"),
    jobMeta: document.getElementById("job-meta"),
    files: document.getElementById("stat-files"),
    bytes: document.getElementById("stat-bytes"),
    speedStat: document.getElementById("stat-speed"),
    current: document.getElementById("stat-current"),
    bar: document.getElementById("bar"),
    pct: document.getElementById("pct"),
    eta: document.getElementById("eta"),
    etaNote: document.getElementById("eta-note"),
    dests: document.getElementById("dests"),
    stateLine: document.getElementById("state-line"),
    activityAge: document.getElementById("activity-age"),
    activity: document.getElementById("activity"),
    diagnostics: document.getElementById("diagnostics"),
    errors: document.getElementById("errors"),
    summary: document.getElementById("summary"),
    reportWrap: document.getElementById("report-link-wrap"),
    reportLink: document.getElementById("report-link"),
    reportTxt: document.getElementById("report-txt"),
    modal: document.getElementById("confirm-modal"),
    confirmText: document.getElementById("confirm-text"),
    confirmOk: document.getElementById("confirm-ok"),
    confirmCancel: document.getElementById("confirm-cancel"),
    linkWarning: document.getElementById("link-warning"),
    speedTable: document.getElementById("speed-table"),
    speedDiagnosis: document.getElementById("speed-diagnosis"),
  };

  let activeJobId = null;
  let pollTimer = null;
  let seenEvents = 0;
  let starting = false;
  let renderedActivity = -1;
  let renderedDiagnostics = -1;
  let lastAct = null;
  // What earlier polls saw per destination (speed samples, a finished cascade pass's figures).
  let destMemory = { seen: {}, samples: {} };
  let destMemoryJob = null;
  /** @type {Map<string, object>} */
  const presetsByName = new Map();
  const driveResults = new Map();
  const driveBlockers = new Map(); // drive key to what holds it, kept across the 15 s refresh
  let pendingConfirmResolve = null;
  let driveRefreshTimer = null;
  let driveRefreshSequence = 0;

  function lines(text) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function fmtBytes(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let v = Number(n);
    let i = 0;
    while (v >= 1024 && i < u.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  function fmtSpeed(bps) {
    if (bps == null) return "—";
    return `${fmtBytes(bps)}/s`;
  }

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || res.statusText || String(res.status));
      error.data = data;
      throw error;
    }
    return data;
  }

  function numOrNull(input) {
    const v = input.value.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  function formBody(confirm) {
    return {
      src: lines(el.src.value),
      dest: lines(el.dest.value),
      mode: el.mode.value,
      verify: el.verify.checked,
      perfectVerify: el.perfectVerify.checked,
      hash: el.hash.value,
      include: el.include.value.trim(),
      exclude: el.exclude.value.trim(),
      minSize: numOrNull(el.minSize),
      maxSize: numOrNull(el.maxSize),
      fromDate: el.fromDate.value.trim() || null,
      toDate: el.toDate.value.trim() || null,
      speed: el.speed.value,
      diskMode: "auto",
      testDriveSpeed: el.testDriveSpeed.checked,
      cooldownSeconds: Number(el.cooldownSeconds.value) || 0,
      cooldownEveryGb: Number(el.cooldownEveryGb.value) || 0,
      cooldownDropPercent: Number(el.cooldownDropPercent.value) || 20,
      nonstop: el.nonstop.checked,
      confirm: !!confirm,
      cascade: el.cascade.checked,
      writeMhl: el.writeMhl.checked,
      writeReport: el.writeReport.checked,
      keepAwake: el.keepAwake.checked,
      jobName: el.jobName.value.trim() || null,
      volumeBindings: [...new Set([...lines(el.src.value), ...lines(el.dest.value)])]
        .map((p) => selectedBindings.get(p))
        .filter(Boolean),
    };
  }

  function applyPreset(p) {
    if (!p) return;
    if (Array.isArray(p.src) && p.src.filter(Boolean).length) {
      el.src.value = p.src.filter(Boolean).join("\n");
    }
    if (Array.isArray(p.dest)) {
      el.dest.value = p.dest.map((d) => d || "").join("\n");
    }
    if (p.mode) el.mode.value = p.mode;
    if (p.hash) el.hash.value = p.hash;
    if (p.speed) el.speed.value = p.speed;
    if (typeof p.verify === "boolean") el.verify.checked = p.verify;
    if (typeof p.perfectVerify === "boolean") el.perfectVerify.checked = p.perfectVerify;
    if (typeof p.nonstop === "boolean") el.nonstop.checked = p.nonstop;
    if (typeof p.cascade === "boolean") el.cascade.checked = p.cascade;
    if (typeof p.writeMhl === "boolean") el.writeMhl.checked = p.writeMhl;
    if (typeof p.writeReport === "boolean") el.writeReport.checked = p.writeReport;
    if (typeof p.keepAwake === "boolean") el.keepAwake.checked = p.keepAwake;
    if (typeof p.testDriveSpeed === "boolean") el.testDriveSpeed.checked = p.testDriveSpeed;
    if (p.cooldownSeconds != null) el.cooldownSeconds.value = p.cooldownSeconds;
    if (p.cooldownEveryGb != null) el.cooldownEveryGb.value = p.cooldownEveryGb;
    if (p.cooldownDropPercent != null) el.cooldownDropPercent.value = p.cooldownDropPercent;
    if (p.include != null) el.include.value = p.include;
    if (p.exclude != null) el.exclude.value = p.exclude;
    el.minSize.value = p.minSize != null ? p.minSize : "";
    el.maxSize.value = p.maxSize != null ? p.maxSize : "";
    el.fromDate.value = p.fromDate || "";
    el.toDate.value = p.toDate || "";
    if (p.name) el.jobName.value = p.name;
    onPathsChanged();
    scheduleDriveRefresh();
  }

  async function loadPresets() {
    const data = await api("/api/presets");
    el.preset.innerHTML = '<option value="">— custom —</option>';
    presetsByName.clear();
    for (const item of data.presets || []) {
      const p = item.preset || {};
      const name = item.name || p.name;
      presetsByName.set(name, p);
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = p.label || name;
      el.preset.appendChild(opt);
    }
  }

  async function refreshHealth() {
    try {
      const h = await api("/api/health");
      el.health.textContent = h.engineExists
        ? `engine OK · :${location.port || 80} · ${h.phase || "p2"}`
        : "engine missing";
      el.health.className = "health " + (h.engineExists ? "ok" : "bad");
    } catch (e) {
      el.health.textContent = "server down";
      el.health.className = "health bad";
    }
  }

  /** @type {object[]} */
  let volumeList = [];
  let volumesLoaded = false;
  let pickerVolume = null;
  let pickerDir = null;
  const selectedBindings = new Map();
  let checkTimer = null;
  let checkSeq = 0;

  function isLocked() {
    return el.run.disabled;
  }

  function fmtCap(n) {
    return n == null ? "unavailable" : fmtBytes(n);
  }

  function currentRoles() {
    return DitRoles.rolesFor(volumeList, lines(el.src.value), lines(el.dest.value));
  }

  function volumeForPath(p, volumes = volumeList) {
    return volumes.find((v) => DitRoles.belongs(p, v, volumes)) || null;
  }

  function bindPath(p, replace = false) {
    if (!replace && selectedBindings.has(p)) return;
    const v = volumeForPath(p);
    if (v && v.identity) selectedBindings.set(p, { path: p, identity: v.identity, root: v.mount, name: v.name });
  }

  function bindingErrors() {
    const paths = [...lines(el.src.value), ...lines(el.dest.value)];
    return paths.flatMap((p) => {
      const old = selectedBindings.get(p);
      if (!old) return [];
      const current = volumeForPath(p);
      return !current || current.identity !== old.identity
        ? [`Selection unresolved for ${p}; choose the folder again on its current volume`]
        : [];
    });
  }

  function setRole(v, role, action) {
    if (isLocked()) return;
    const box = role === "source" ? el.src : el.dest;
    if (action === "add") {
      box.value = DitRoles.addLine(box.value, v.path);
      bindPath(v.path, true);
    } else if (action === "clear") {
      const removed = lines(box.value).filter((p) => DitRoles.belongs(p, v, volumeList));
      box.value = DitRoles.clearLines(box.value, v, volumeList);
      removed.forEach((p) => selectedBindings.delete(p));
    }
    else return;
    onPathsChanged();
  }

  function roleButton(v, role, roles) {
    const st = DitRoles.buttonState(v, role, roles, isLocked());
    const b = document.createElement("button");
    b.type = "button";
    b.className = "role";
    b.dataset.role = role;
    b.textContent = st.label;
    b.setAttribute("aria-pressed", st.pressed ? "true" : "false");
    if (st.blocked) {
      b.setAttribute("aria-disabled", "true");
      b.title = st.reason;
      b.setAttribute("aria-label", `${v.name}, ${role}: ${st.label}${st.reason && st.reason !== st.label ? " (" + st.reason + ")" : ""}`);
    } else {
      b.setAttribute("aria-label", `${v.name}: ${st.label}`);
    }
    b.addEventListener("click", () => setRole(v, role, st.action));
    return b;
  }

  function renderVolumes(volumes) {
    volumeList = volumes;
    for (const v of volumes) delete v.unresolved;
    if (pickerVolume) {
      const currentPicker = volumes.find((v) => v.name === pickerVolume.name);
      if (!currentPicker || currentPicker.identity !== pickerVolume.identity) pickerVolume.unresolved = true;
    }
    for (const [p, binding] of selectedBindings) {
      const current = volumeForPath(p, volumes);
      if (current && current.identity !== binding.identity) current.unresolved = true;
    }
    const roles = currentRoles();
    el.volumes.innerHTML = "";
    if (!volumes.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = volumesLoaded ? "No volumes found under /Volumes" : "Loading volumes…";
      el.volumes.appendChild(li);
      return;
    }
    for (const v of volumes) {
      const li = document.createElement("li");
      li.className = "vol";
      li.dataset.volume = v.name;
      const head = document.createElement("div");
      head.className = "vol-head";
      head.innerHTML = '<span class="vol-name"></span><span class="vol-path mono"></span>';
      head.children[0].textContent = v.name;
      head.children[1].textContent = v.path;
      li.appendChild(head);

      const cap = document.createElement("div");
      cap.className = "vol-cap" + (v.capacityKnown ? "" : " unavailable");
      cap.textContent = v.capacityKnown
        ? `Total ${fmtCap(v.totalBytes)} · Used ${fmtCap(v.usedBytes)} (${v.usedPercent}%) · Free ${fmtCap(v.freeBytes)}`
        : "Capacity unavailable";
      li.appendChild(cap);

      const bar = document.createElement("div");
      bar.className = "vol-bar" + (v.usedPercent >= 98 ? " full" : v.usedPercent >= 90 ? " high" : "");
      bar.setAttribute("role", "img");
      bar.setAttribute(
        "aria-label",
        v.capacityKnown ? `${v.name}: ${v.usedPercent}% used` : `${v.name}: capacity unavailable`
      );
      const fill = document.createElement("span");
      fill.style.width = v.capacityKnown ? `${Math.min(100, v.usedPercent)}%` : "0%";
      bar.appendChild(fill);
      li.appendChild(bar);

      const actions = document.createElement("div");
      actions.className = "vol-actions";
      actions.appendChild(roleButton(v, "source", roles));
      actions.appendChild(roleButton(v, "destination", roles));
      const folder = document.createElement("button");
      folder.type = "button";
      folder.className = "folder";
      folder.textContent = "Choose folder";
      folder.setAttribute("aria-label", `${v.name}: choose a folder`);
      folder.setAttribute("aria-disabled", v.readable ? "false" : "true");
      folder.addEventListener("click", () => v.readable && openPicker(v));
      actions.appendChild(folder);
      li.appendChild(actions);

      const r = roles[v.name] || {};
      const notes = [];
      if (v.status !== "ready") notes.push("Not readable");
      if (!v.destination.allowed) notes.push(`Destination: ${v.destination.reason}`);
      if (!v.source.allowed && v.status === "ready") notes.push(`Source: ${v.source.reason}`);
      if (v.device) notes.push(v.device);
      if (v.unresolved) notes.push("Selection unresolved: volume changed; choose it again");
      const note = document.createElement("div");
      note.className = "vol-note" + (r.source && r.destination ? " conflict" : "");
      note.textContent =
        r.source && r.destination
          ? "Conflict: this volume is both a source and a destination"
          : notes.join(" · ");
      li.appendChild(note);
      el.volumes.appendChild(li);
    }
  }

  async function loadVolumes() {
    const data = await api("/api/volumes");
    volumesLoaded = true;
    renderVolumes(data.volumes || []);
    scheduleDriveRefresh();
    // Paths restored before the drive list arrived (a refresh, a preset, a running job) could not be matched to a
    // drive yet. Match them now, then check again, so the form never stays refused for a missing drive identity.
    const before = selectedBindings.size;
    [...lines(el.src.value), ...lines(el.dest.value)].forEach((p) => bindPath(p));
    if (selectedBindings.size !== before) onPathsChanged();
    else if (selectedBindings.size && bindingErrors().length) runCheck();
  }

  // ---- folder picker (server side list under the chosen volume)

  async function showFolder(dir) {
    if (!pickerVolume || !pickerVolume.identity) throw new Error("Selected volume identity is unavailable; refresh volumes");
    const root = pickerVolume.root || pickerVolume.path;
    const q = new URLSearchParams({ path: dir, root, identity: pickerVolume.identity });
    const data = await api("/api/folders?" + q.toString());
    if (data.identity !== pickerVolume.identity || data.root !== root) {
      throw new Error("Selected volume changed; close the picker and choose it again");
    }
    pickerDir = data.path;
    el.pickerPath.textContent = data.path;
    el.pickerList.innerHTML = "";
    for (const f of data.folders) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = f.name;
      b.addEventListener("click", () => showFolder(f.path).catch((e) => (el.pickerNote.textContent = e.message)));
      li.appendChild(b);
      el.pickerList.appendChild(li);
    }
    if (!data.folders.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No sub folders";
      el.pickerList.appendChild(li);
    }
    el.pickerNote.textContent = data.truncated ? "List cut at 500 folders; type the path in the box instead." : "";
    el.pickerUp.setAttribute("aria-disabled", data.path === data.root ? "true" : "false");
    updatePickerButtons();
  }

  function updatePickerButtons() {
    if (!pickerVolume) return;
    const roles = currentRoles();
    for (const [btn, role] of [[el.pickerSource, "source"], [el.pickerDest, "destination"]]) {
      const st = DitRoles.buttonState(pickerVolume, role, roles, isLocked());
      const taken = st.blocked && st.label.startsWith("Selected as");
      const blocked = st.blocked && !(st.pressed); // a role already held may still take a folder
      btn.textContent = blocked ? st.label : role === "source" ? "Use as source" : "Use as destination";
      btn.setAttribute("aria-disabled", blocked ? "true" : "false");
      btn.title = blocked ? st.reason : "";
      btn.dataset.taken = taken ? "1" : "";
    }
  }

  async function openPicker(v) {
    pickerVolume = v;
    el.pickerTitle.textContent = `Choose folder in ${v.name}`;
    el.picker.classList.remove("hidden");
    try {
      await showFolder(v.root || v.path);
    } catch (e) {
      el.pickerNote.textContent = e.message;
    }
  }

  function useFolder(role) {
    if (!pickerVolume || !pickerDir || isLocked()) return;
    const currentPicker = volumeList.find((v) => v.name === pickerVolume.name);
    if (!pickerVolume.identity || !currentPicker || currentPicker.identity !== pickerVolume.identity) {
      el.pickerNote.textContent = "Selected volume changed; close the picker and choose the volume again";
      return;
    }
    const root = currentPicker.root || currentPicker.path;
    if (!DitRoles.under(pickerDir, root)) {
      el.pickerNote.textContent = "Cannot use a folder outside the selected volume";
      return;
    }
    const st = DitRoles.buttonState(pickerVolume, role, currentRoles(), false);
    if (st.blocked) return;
    const box = role === "source" ? el.src : el.dest;
    if (currentPicker.unresolved) {
      const stale = lines(box.value).filter((p) => DitRoles.belongs(p, currentPicker, volumeList));
      box.value = DitRoles.clearLines(box.value, currentPicker, volumeList);
      stale.forEach((p) => selectedBindings.delete(p));
    }
    box.value = DitRoles.chooseFolderLine(box.value, pickerVolume, pickerDir);
    bindPath(pickerDir, true);
    onPathsChanged();
  }

  // ---- resolved paths, refusals and the space check

  function addLine(parent, cls, text) {
    const d = document.createElement("div");
    d.className = "line " + cls;
    d.textContent = text;
    parent.appendChild(d);
  }

  function renderCheck(res) {
    const box = el.checkBody;
    box.innerHTML = "";
    box.classList.remove("muted");
    for (const e of res.errors || []) {
      addLine(box, "bad", "Refused: " + e);
    }
    for (const e of bindingErrors()) addLine(box, "bad", "Refused: " + e);
    for (const s of res.src || []) {
      addLine(box, s.exists ? "good" : "bad", `Source ${s.input} → ${s.resolved}${s.exists ? "" : " (missing)"}`);
    }
    for (const d of res.dest || []) {
      const sp = (res.space || []).find((x) => x.path === d.input);
      const free = sp ? ` · free ${fmtCap(sp.freeBytes)}` : "";
      addLine(box, "good", `Destination ${d.input} → ${d.resolved}${d.exists ? "" : " (will be created)"}${free}`);
    }
    if (res.scan) {
      addLine(
        box,
        "muted",
        `${DitRoles.spaceLabel(res.scan)}: ${fmtBytes(res.scan.totalBytes)} in ${res.scan.totalFiles} files; every destination receives all sources.`
      );
    }
    for (const sp of res.space || []) {
      if (sp.short) {
        addLine(
          box,
          "warn",
          `Not enough space on ${sp.path}: ${fmtCap(sp.freeBytes)} free, ${fmtBytes(sp.neededBytes)} planned. ${sp.explanation}`
        );
      }
    }
    for (const w of (res.warnings || []).filter((x) => !x.startsWith("Not enough space"))) {
      addLine(box, "warn", w);
    }
    if (!(res.src || []).length && !(res.dest || []).length) {
      box.textContent = "Add a source and a destination.";
      box.classList.add("muted");
    }
  }

  async function runCheck() {
    const seq = ++checkSeq;
    const body = { ...formBody(false) };
    if (!body.src.length && !body.dest.length) {
      renderCheck({});
      return;
    }
    try {
      const res = await api("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (seq === checkSeq) renderCheck(res);
    } catch (e) {
      if (seq === checkSeq) {
        el.checkBody.textContent = "Check failed: " + e.message;
      }
    }
  }

  /** The text boxes changed: redraw roles at once, check the paths shortly after. */
  function onPathsChanged() {
    [...lines(el.src.value), ...lines(el.dest.value)].forEach((p) => bindPath(p));
    renderVolumes(volumeList);
    updatePickerButtons();
    clearTimeout(checkTimer);
    checkTimer = setTimeout(runCheck, 400);
  }

  /** Who is holding the drive, and what the person can do about it. Nothing here runs without a confirmation. */
  function buildBlockersBox(info, attempt) {
    const box = document.createElement("div");
    box.className = "drive-blockers";
    const intro = document.createElement("div");
    intro.textContent = "These programs are holding this drive:";
    box.appendChild(intro);
    const list = document.createElement("ul");
    for (const b of info.blockers) {
      const item = document.createElement("li");
      item.textContent = b.sentence + (b.restarted ? ". It started itself again, so it is probably a login item" : "") + (b.note ? ". " + b.note : "");
      list.appendChild(item);
    }
    box.appendChild(list);
    const actions = document.createElement("div");
    actions.className = "drive-blocker-actions";
    const quitters = info.blockers.filter((b) => b.canQuit);
    const names = [...new Set(quitters.map((b) => b.app || b.command))].join(", ");
    const add = (label, handler, danger = false) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = label;
      if (danger) btn.className = "danger";
      btn.addEventListener("click", handler);
      actions.appendChild(btn);
    };
    if (quitters.length) {
      add(`Quit ${names}`, () => {
        if (window.confirm(`Ask ${names} to quit? Anything unsaved in ${quitters.length > 1 ? "them" : "it"} could be lost.`)) attempt("quit");
      });
    }
    if (info.forceAllowed) {
      add("Eject anyway", () => {
        if (window.confirm("Nothing is writing to this drive, so forcing the unmount will not lose data. The programs holding it will lose access to it. Eject anyway?")) attempt("force");
      }, true);
    }
    add("Try again", () => attempt(undefined));
    box.appendChild(actions);
    return box;
  }

  function renderDriveActions(drives, unsupported = "") {
    el.driveActions.innerHTML = "";
    if (!drives.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = unsupported || "No external drives are mounted.";
      el.driveActions.appendChild(li);
      return;
    }
    for (const drive of drives) {
      const key = drive.wholeDisk || drive.path;
      const li = document.createElement("li");
      const description = document.createElement("span");
      description.className = "drive-description";
      description.textContent = drive.wholeDisk
        ? `${drive.volumeName} · ${drive.mountPoint} · ${drive.wholeDisk}`
        : drive.paths?.[0] || drive.path;
      li.appendChild(description);
      const result = document.createElement("span");
      result.className = "drive-result";
      const saved = driveResults.get(key);
      if (saved) {
        result.textContent = saved.text;
        result.classList.toggle("safe", saved.state === "safe");
        result.classList.toggle("failed", saved.state === "failed");
      } else if (drive.reason) {
        result.textContent = `Could not eject: ${drive.reason}`;
        result.classList.add("failed");
      } else {
        result.textContent = "Ready";
      }
      result.setAttribute("role", "status");
      li.appendChild(result);
      if (drive.wholeDisk) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "danger drive-eject";
        // "Stop and eject" only when a copy is running. Otherwise this unmounts the drive so it is safe to unplug.
        const verb = isLocked() ? "Stop and eject" : "Eject";
        button.textContent = verb;
        button.title = isLocked() ? "Stops the running copy after the current file, then unmounts the drive" : "Unmounts the drive so it is safe to unplug";
        button.setAttribute("aria-label", `${verb} ${drive.volumeName}`);
        button.disabled = saved?.state === "stopping";
        // resolve: undefined = just try, "quit" = ask the person's own programs that hold the drive to quit, "force" = unmount anyway.
        const attempt = async (resolve) => {
          const text = resolve === "quit" ? "Asking the programs to quit" : resolve === "force" ? "Forcing the unmount" : "Stopping";
          driveResults.set(key, { state: "stopping", text });
          result.textContent = text;
          result.className = "drive-result";
          button.disabled = true;
          try {
            const response = await api("/api/drives/eject", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: drive.mountPoint, resolve }),
            });
            driveResults.set(key, { state: "safe", text: response.drive?.message || "Safe to unplug" });
            driveBlockers.delete(key);
            li.querySelector(".drive-blockers")?.remove();
            result.textContent = response.drive?.message || "Safe to unplug";
            result.className = "drive-result safe";
            button.disabled = true;
            if (response.jobId) await pollJob();
          } catch (e) {
            const failure = `Could not eject: ${e.message}`;
            driveResults.set(key, { state: "failed", text: failure });
            result.textContent = failure;
            result.className = "drive-result failed";
            button.disabled = false;
            if (e.data?.blockers?.length) {
              driveBlockers.set(key, { blockers: e.data.blockers, forceAllowed: !!e.data.forceAllowed });
              li.querySelector(".drive-blockers")?.remove();
              li.appendChild(buildBlockersBox(driveBlockers.get(key), attempt));
            }
          }
        };
        button.addEventListener("click", () => attempt(undefined));
        li.appendChild(button);
        if (driveBlockers.has(key) && saved?.state === "failed") li.appendChild(buildBlockersBox(driveBlockers.get(key), attempt));
      }
      el.driveActions.appendChild(li);
    }
  }

  async function loadDriveTargets() {
    const sequence = ++driveRefreshSequence;
    const targets = [...new Set([...lines(el.src.value), ...lines(el.dest.value)])];
    const query = new URLSearchParams(); // with no paths the server lists every external drive
    targets.forEach((target) => query.append("path", target));
    try {
      const data = await api(`/api/drive-targets?${query.toString()}`);
      if (sequence === driveRefreshSequence) renderDriveActions(data.drives || [], data.unsupported || "");
    } catch (e) {
      if (sequence !== driveRefreshSequence) return;
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = `Could not inspect drive paths: ${e.message}`;
      el.driveActions.replaceChildren(li);
    }
  }

  function scheduleDriveRefresh() {
    if (driveRefreshTimer) clearTimeout(driveRefreshTimer);
    driveRefreshTimer = setTimeout(() => loadDriveTargets().catch(() => {}), 350);
  }

  function resetProgress() {
    seenEvents = 0;
    el.errors.innerHTML = "";
    el.summary.textContent = "—";
    el.files.textContent = "—";
    el.bytes.textContent = "—";
    el.speedStat.textContent = "—";
    el.current.textContent = "—";
    el.bar.style.width = "0%";
    el.pct.textContent = "—";
    el.eta.textContent = "—";
    el.etaNote.textContent = "";
    el.dests.innerHTML = "";
    destRows.clear();
    destMemory = { seen: {}, samples: {} };
    destMemoryJob = null;
    el.activity.innerHTML = "";
    el.diagnostics.innerHTML = "";
    renderedActivity = -1;
    renderedDiagnostics = -1;
    lastAct = null;
    setState("Idle", "idle");
    el.activityAge.textContent = "";
    el.reportWrap.classList.add("hidden");
    el.linkWarning.classList.add("hidden");
    el.linkWarning.textContent = "";
    el.speedTable.replaceChildren();
    renderedSpeedSig = null;
    el.speedDiagnosis.textContent = "";
  }

  function setState(text, cls) {
    el.stateLine.textContent = text;
    el.stateLine.className = "state " + cls;
  }

  function stateClass(state) {
    if (state === "Done") return "good";
    if (state === "Failed" || state === "Cancelled" || state === "Done with errors") return "bad";
    return "live";
  }

  function pctOf(done, total) {
    if (!total || done == null) return null;
    if (done >= total) return 100;
    return Math.floor((done / total) * 100);
  }

  function fmtAge(sec) {
    if (sec < 1) return "less than 1 s ago";
    if (sec < 60) return `${Math.floor(sec)} s ago`;
    const m = Math.floor(sec / 60);
    return `${m} min ${Math.floor(sec % 60)} s ago`;
  }

  function tickAge() {
    if (!lastAct || lastAct.at == null) {
      el.activityAge.textContent = "";
      return;
    }
    const age = (lastAct.now - lastAct.at + (performance.now() - lastAct.fetched)) / 1000;
    el.activityAge.textContent = lastAct.live
      ? `last activity ${fmtAge(Math.max(0, age))}`
      : "";
  }

  const destRows = new Map();
  let renderedSpeedSig = null;

  /** The job ETA and one row per destination: phase, bytes, speed, and its own error. */
  function renderDestinations(job) {
    if (destMemoryJob !== job.id) {
      destMemory = { seen: {}, samples: {} };
      destMemoryJob = job.id;
    }
    const eta = DitDest.etaView(job);
    el.eta.textContent = eta.text;
    el.etaNote.textContent = eta.note;
    const { rows } = DitDest.buildRows(job, destMemory, performance.now());
    const keep = new Set();
    for (const row of rows) {
      keep.add(row.name);
      let ref = destRows.get(row.name);
      if (!ref) {
        const li = document.createElement("li");
        const head = document.createElement("div");
        head.className = "dest-head";
        const name = document.createElement("span");
        name.className = "dest-name mono";
        name.textContent = row.name;
        const phase = document.createElement("span");
        phase.className = "dest-phase";
        head.append(name, phase);
        const bar = document.createElement("div");
        bar.className = "dest-bar";
        const fill = document.createElement("span");
        bar.appendChild(fill);
        const meta = document.createElement("div");
        meta.className = "dest-meta mono";
        const err = document.createElement("div");
        err.className = "dest-error";
        li.append(head, bar, meta, err);
        ref = { li, phase, bar, fill, meta, err };
        destRows.set(row.name, ref);
      }
      ref.li.className = "dest tone-" + row.tone;
      ref.phase.textContent = row.label;
      ref.bar.hidden = !row.known;
      ref.meta.hidden = !row.known;
      if (row.known) {
        const pct = row.total ? Math.min(100, (row.written / row.total) * 100) : 0;
        ref.fill.style.width = pct + "%";
        ref.meta.textContent =
          `${fmtBytes(row.written)}${row.total != null ? " / " + fmtBytes(row.total) : ""} written` +
          (row.verifiedKnown === false ? "" : ` · ${fmtBytes(row.verified)} verified`) +
          (row.speedBps != null ? ` · ${fmtSpeed(row.speedBps)}` : "");
      }
      ref.err.hidden = !row.error;
      ref.err.textContent = row.error || "";
      if (ref.li.parentNode !== el.dests) el.dests.appendChild(ref.li);
    }
    for (const [name, ref] of [...destRows]) {
      if (!keep.has(name)) { ref.li.remove(); destRows.delete(name); }
    }
  }

  function renderList(ul, items, build) {
    const stick = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 8;
    ul.innerHTML = "";
    for (const it of items) ul.appendChild(build(it));
    if (stick) ul.scrollTop = ul.scrollHeight;
  }

  function showReport(job) {
    const reports = job.reports || {};
    if (reports.html || (job.status === "done" || job.status === "done_with_errors")) {
      const url = `/reports/${encodeURIComponent(job.id)}.html`;
      el.reportLink.href = url;
      el.reportLink.textContent = "open HTML report";
      el.reportTxt.textContent = reports.txt ? ` · ${reports.txt}` : "";
      el.reportWrap.classList.remove("hidden");
    }
  }

  let formFilledFor = null;
  let lastRunning = null;
  function applyJob(job) {
    // A refresh, a second window or the native app opened mid-copy: show what is being copied.
    if (formFilledFor !== job.id) {
      formFilledFor = job.id;
      if (DitJobForm.formIsEmpty(el.src.value, el.dest.value)) {
        const p = DitJobForm.jobToPreset(job);
        if (p) applyPreset(p);
      }
    }
    if (["done", "done_with_errors", "error", "cancelled"].includes(job.status)) showingFinishedJob = true;
    el.jobMeta.textContent =
      `${job.id} · ${job.status}` + (otherRunning > 0 ? ` · ${otherRunning} other running` : "");
    const p = job.progress || {};
    const usb2 = (job.driveLinks || []).filter((link) => link.warning);
    el.linkWarning.textContent = usb2.map((link) => `${link.destination}: ${link.warning}`).join(" · ");
    el.linkWarning.classList.toggle("hidden", !usb2.length);
    const speedSig = JSON.stringify([job.id, job.dest, (job.speedSamples || []).slice(-40).length, ((job.speedSamples || []).slice(-1)[0] || {}).timestampUtc]);
    if (speedSig !== renderedSpeedSig) {
      renderedSpeedSig = speedSig;
    const tableHead = document.createElement("thead");
    const header = document.createElement("tr");
    ["Time", ...(job.dest || [])].forEach((label) => { const th = document.createElement("th"); th.textContent = label; header.appendChild(th); });
    tableHead.appendChild(header);
    const tableBody = document.createElement("tbody");
    (job.speedSamples || []).slice(-40).forEach((sample) => {
      const row = document.createElement("tr");
      const time = document.createElement("td"); time.textContent = sample.timestampUtc ? new Date(sample.timestampUtc).toLocaleTimeString() : "—"; row.appendChild(time);
      for (const dest of job.dest || []) {
        const cell = document.createElement("td");
        const rate = (sample.destinations || []).find((item) => String(item.destination).replace(/\\/g, "/").replace(/\/$/, "") === String(dest).replace(/\\/g, "/").replace(/\/$/, ""));
        cell.textContent = rate ? `${fmtSpeed(rate.speedBps)} · ${fmtBytes(rate.bytes)}` : "—"; row.appendChild(cell);
      }
      tableBody.appendChild(row);
    });
    el.speedTable.replaceChildren(tableHead, tableBody);
    }
    const testInfo = (job.speedTestResults || []).map((result) => result.error ? `${result.destination}: ${result.error}` : `${result.destination}: test write ${fmtSpeed(result.writeBps)}, read ${fmtSpeed(result.readBps)}`).join(" · ");
    el.speedDiagnosis.textContent = [job.speedDiagnosis, testInfo].filter(Boolean).join(" · ");
    const totalFiles = p.total_files;
    const totalBytes = p.total_bytes;
    // Completed counts every planned file that has finished (copied, skipped or failed).
    const doneFiles = p.done_files;
    const doneBytes = p.done_bytes;
    const finished = job.status === "done" || job.status === "done_with_errors";

    if (totalFiles != null) {
      const pf = pctOf(doneFiles ?? 0, totalFiles);
      el.files.textContent = `${doneFiles ?? 0} / ${totalFiles}` + (pf != null ? ` · ${pf}%` : "");
    } else if (finished && job.summary) {
      el.files.textContent = String(job.summary.copied_files ?? "—");
    }
    if (totalBytes != null) {
      const pb = pctOf(doneBytes ?? 0, totalBytes);
      el.bytes.textContent =
        `${fmtBytes(doneBytes ?? 0)} / ${fmtBytes(totalBytes)}` + (pb != null ? ` · ${pb}%` : "");
    } else if (finished && job.summary) {
      el.bytes.textContent = fmtBytes(job.summary.bytes);
    }
    el.speedStat.textContent = fmtSpeed(p.speed_bps);
    if (p.current) el.current.textContent = p.current;

    const barPct = totalBytes ? pctOf(doneBytes ?? 0, totalBytes) : pctOf(doneFiles ?? 0, totalFiles);
    if (barPct != null) {
      el.bar.style.width = barPct + "%";
      el.pct.textContent = `${barPct}% of planned ${totalBytes ? "bytes" : "files"}` +
        (job.passes > 1 ? ` · pass ${job.pass} of ${job.passes}` : "");
    } else if (finished) {
      el.bar.style.width = "100%";
      el.pct.textContent = "100%";
    } else {
      el.pct.textContent = "Planned totals not known yet";
    }

    renderDestinations(job);

    const running0 = job.status === "running" || job.status === "queued";
    const stateText = DitDest.jobStateText(job);
    setState(stateText, stateClass(job.state || job.status));
    lastAct = {
      at: job.lastActivityAt,
      now: job.serverNow,
      fetched: performance.now(),
      live: running0,
    };
    tickAge();

    const acts = job.activity || [];
    const lastSeq = acts.length ? acts[acts.length - 1].seq : 0;
    if (lastSeq !== renderedActivity) {
      const buildActivity = (a) => {
        const li = document.createElement("li");
        li.className = a.kind;
        li.textContent = `${new Date(a.at).toLocaleTimeString()}  ${a.text}`;
        return li;
      };
      if (renderedActivity < 0 || lastSeq < renderedActivity) {
        // First draw, or a different job: draw everything once.
        renderList(el.activity, acts, buildActivity);
      } else {
        // Same job: append only the new lines and trim the oldest, so the list is not rebuilt on every poll.
        const ul = el.activity;
        const stick = ul.scrollTop + ul.clientHeight >= ul.scrollHeight - 8;
        for (const a of acts) if (a.seq > renderedActivity) ul.appendChild(buildActivity(a));
        while (ul.children.length > acts.length) ul.removeChild(ul.firstChild);
        if (stick) ul.scrollTop = ul.scrollHeight;
      }
      renderedActivity = lastSeq;
    }
    const diags = job.diagnostics || [];
    const lastDiag = diags.length ? diags[diags.length - 1].at + ":" + diags.length : 0;
    if (lastDiag !== renderedDiagnostics) {
      renderedDiagnostics = lastDiag;
      renderList(el.diagnostics, diags, (d) => {
        const li = document.createElement("li");
        li.className = "stderr";
        li.textContent = `${new Date(d.at).toLocaleTimeString()}  ${d.line}`;
        return li;
      });
    }

    const events = job.events || [];
    for (let i = seenEvents; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === "error" || (ev.type === "file" && ev.status === "error")) {
        const li = document.createElement("li");
        li.textContent = ev.message || ev.error || ev.path || JSON.stringify(ev);
        el.errors.appendChild(li);
      }
    }
    seenEvents = events.length;

    if (job.summary) {
      el.summary.textContent = JSON.stringify(job.summary, null, 2);
    } else if (job.error) {
      el.summary.textContent = job.error;
    }

    if (job.reports && (job.reports.html || (job.reports.mhl && job.reports.mhl.length))) {
      showReport(job);
    }

    const running = ["running", "queued", "pausing", "stopping"].includes(job.status);
    const requesting = job.status === "pausing" || job.status === "stopping";
    const resumable = ["paused", "stopped", "incomplete"].includes(job.status) && !job.resumedBy;
    if (running !== lastRunning) { lastRunning = running; scheduleDriveRefresh(); }
    el.run.disabled = running;
    el.cancel.disabled = !running;
    el.pause.disabled = job.status !== "running";
    el.stop.disabled = job.status !== "running";
    el.resume.disabled = !resumable;
    el.resume.classList.toggle("hidden", !resumable);
    const retryFailed = !!job.retryFailedAvailable;
    el.retryFailed.disabled = !retryFailed;
    el.retryFailed.classList.toggle("hidden", !retryFailed);
    el.pause.textContent = requesting && job.status === "pausing" ? "Pausing…" : "Pause after file";
    el.stop.textContent = requesting && job.status === "stopping" ? "Stopping…" : "Stop after file";
    if (!running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function pollJob() {
    if (!activeJobId) return;
    try {
      const job = await api("/api/jobs/" + encodeURIComponent(activeJobId));
      applyJob(job);
    } catch (e) {
      el.jobMeta.textContent = "poll error: " + e.message;
    }
  }

  function askConfirm(mode) {
    return new Promise((resolve) => {
      pendingConfirmResolve = resolve;
      el.confirmText.textContent = `Mode “${mode}” can delete or move data. Confirm to continue.`;
      el.modal.classList.remove("hidden");
    });
  }

  function closeConfirm(result) {
    el.modal.classList.add("hidden");
    if (pendingConfirmResolve) {
      pendingConfirmResolve(result);
      pendingConfirmResolve = null;
    }
  }

  let otherRunning = 0;
  let showingFinishedJob = false;

  /** Attach to the newest running job, so a refresh or a second window shows the live job. */
  async function attachRunning() {
    if (starting || pollTimer || showingFinishedJob) return;
    let list;
    try {
      list = (await api("/api/jobs")).jobs || [];
    } catch {
      return;
    }
    if (starting || pollTimer || showingFinishedJob) return;
    const pick = DitAttach.pickAttach(list, activeJobId);
    if (!pick) return;
    const selected = pick.job;
    const live = pick.live ? [selected] : [];
    otherRunning = pick.otherRunning;
    activeJobId = selected.id;
    resetProgress();
    if (live[0]) { el.run.disabled = true; el.cancel.disabled = false; }
    pollTimer = setInterval(pollJob, live[0] ? 400 : 1500);
    await pollJob();
  }

  async function startJob() {
    starting = true;
    try {
      await startJobInner();
    } finally {
      starting = false;
    }
  }

  async function startJobInner() {
    otherRunning = 0;
    resetProgress();
    const mode = el.mode.value;
    let confirm = false;
    if (DESTRUCTIVE.has(mode)) {
      confirm = await askConfirm(mode);
      if (!confirm) return;
    }
    const body = formBody(confirm);
    if (!body.src.length || !body.dest.length) {
      el.jobMeta.textContent = "Add at least one source and one destination path.";
      return;
    }
    const stale = bindingErrors();
    if (stale.length) {
      el.jobMeta.textContent = "Refused: " + stale.join(". ");
      el.jobMeta.setAttribute("role", "alert");
      return;
    }
    el.run.disabled = true;
    el.cancel.disabled = false;
    el.jobMeta.textContent = "starting…";
    try {
      const res = await api("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      activeJobId = res.id;
      showingFinishedJob = false;
      el.jobMeta.textContent = `${res.id} · ${res.status}`;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollJob, 400);
      await pollJob();
    } catch (e) {
      el.run.disabled = false;
      el.cancel.disabled = true;
      el.jobMeta.textContent = "Refused: " + e.message;
      el.jobMeta.setAttribute("role", "alert");
      runCheck();
    }
  }

  async function requestBoundary(action) {
    if (!activeJobId) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(activeJobId)}/${action}`, { method: "POST" });
      await pollJob();
    } catch (e) { alert(e.message); }
  }

  async function resumeJob(retryFailed = false) {
    if (!activeJobId) return;
    const previousId = activeJobId;
    el.resume.disabled = true;
    el.retryFailed.disabled = true;
    try {
      const sendResume = (useReplacement) => api(`/api/jobs/${encodeURIComponent(previousId)}/resume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ retryFailed, useReplacement }),
      });
      let res;
      try {
        res = await sendResume(false);
      } catch (e) {
        if (!e.data?.replacements?.length || !window.confirm(e.message)) throw e;
        res = await sendResume(true);
      }
      if (res.src && res.dest) {
        const oldPaths = [...lines(el.src.value), ...lines(el.dest.value)];
        oldPaths.forEach((p) => selectedBindings.delete(p));
        el.src.value = res.src.join("\n");
        el.dest.value = res.dest.join("\n");
        loadVolumes().then(onPathsChanged).catch(() => onPathsChanged());
      }
      activeJobId = res.id;
      showingFinishedJob = false;
      otherRunning = 0;
      resetProgress();
      el.run.disabled = true;
      el.pause.disabled = true;
      el.stop.disabled = true;
      el.cancel.disabled = false;
      el.resume.disabled = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(pollJob, 400);
      await pollJob();
    } catch (e) {
      el.resume.disabled = false;
      el.retryFailed.disabled = false;
      alert(e.message);
    }
  }

  async function cancelJob() {
    if (!activeJobId) return;
    try {
      await api("/api/jobs/" + encodeURIComponent(activeJobId) + "/cancel", {
        method: "POST",
      });
      await pollJob();
    } catch (e) {
      alert(e.message);
    }
  }

  async function saveJob() {
    const name = el.jobName.value.trim();
    if (!name) {
      alert("Enter a job name to save.");
      return;
    }
    const body = { ...formBody(false), name };
    try {
      const res = await api("/api/saved-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      el.jobMeta.textContent = `saved job “${res.name}”`;
    } catch (e) {
      alert(e.message);
    }
  }

  el.run.addEventListener("click", startJob);
  el.cancel.addEventListener("click", cancelJob);
  el.pause.addEventListener("click", () => requestBoundary("pause"));
  el.stop.addEventListener("click", () => requestBoundary("stop"));
  el.resume.addEventListener("click", () => resumeJob(false));
  el.retryFailed.addEventListener("click", () => resumeJob(true));
  el.save.addEventListener("click", saveJob);
  el.src.addEventListener("input", onPathsChanged);
  el.dest.addEventListener("input", onPathsChanged);
  el.pickerSource.addEventListener("click", () => useFolder("source"));
  el.pickerDest.addEventListener("click", () => useFolder("destination"));
  el.pickerClose.addEventListener("click", () => {
    el.picker.classList.add("hidden");
    pickerVolume = null;
  });
  el.pickerUp.addEventListener("click", () => {
    const root = pickerVolume && (pickerVolume.root || pickerVolume.path);
    if (!pickerVolume || !pickerDir || pickerDir === root) return;
    const parent = DitRoles.parentOf(pickerDir);
    if (!DitRoles.under(parent, root)) {
      el.pickerNote.textContent = "Cannot move above the selected volume";
      return;
    }
    showFolder(parent).catch((e) => (el.pickerNote.textContent = e.message));
  });
  // A running job locks role and path edits; the boxes follow the run button.
  new MutationObserver(() => {
    el.src.readOnly = isLocked();
    el.dest.readOnly = isLocked();
    onPathsChanged();
  }).observe(el.run, { attributes: true, attributeFilter: ["disabled"] });
  el.volumesBtn.addEventListener("click", () => {
    loadVolumes().catch((e) => alert(e.message));
  });
  el.src.addEventListener("input", scheduleDriveRefresh);
  el.dest.addEventListener("input", scheduleDriveRefresh);
  el.preset.addEventListener("change", () => {
    const p = presetsByName.get(el.preset.value);
    if (p) {
      applyPreset(p);
      onPathsChanged();
    }
  });
  el.confirmOk.addEventListener("click", () => closeConfirm(true));
  el.confirmCancel.addEventListener("click", () => closeConfirm(false));
  el.modal.addEventListener("click", (e) => {
    if (e.target === el.modal) closeConfirm(false);
  });

  refreshHealth();
  setInterval(refreshHealth, 10000);
  setInterval(tickAge, 1000);
  attachRunning();
  setInterval(attachRunning, 2000);
  loadVolumes().catch(() => {});
  loadDriveTargets().catch(() => {});
  setInterval(() => {
    loadVolumes().catch(() => {});
  }, 15000);
  loadPresets().catch(() => {});
  onPathsChanged();
})();
