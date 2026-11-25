"use strict";
// Source and destination roles for volumes. Pure functions, no page access, so the
// same file runs in the browser and under node for the unit tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitRoles = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // Windows paths use backslashes and ignore case; the same rules must work for both kinds.
  const isWinPath = (p) => /^[A-Za-z]:([\\/]|$)/.test(String(p)) || /^\\\\/.test(String(p));
  const flat = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "") || "/";

  function under(p, base) {
    if (!base) return false;
    const win = isWinPath(base) || isWinPath(p);
    let a = flat(p);
    let b = flat(base);
    if (win) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return a === b || a.startsWith(b === "/" ? "/" : b + "/");
  }

  /** The folder above this one, in the style of the path given. A drive root stays a drive root. */
  function parentOf(p) {
    const n = flat(p);
    const i = n.lastIndexOf("/");
    if (i <= 0) return "/";
    const up = n.slice(0, i);
    if (/^[A-Za-z]:$/.test(up)) return up + "\\";
    return isWinPath(p) ? up.replace(/\//g, "\\") : up;
  }

  function mountPoint(v) {
    return v.mount || (v.root && v.root !== "/" ? v.root : v.path);
  }

  /** Assign a path to its longest actual mount, with the startup root as fallback. */
  function belongs(p, v, volumes) {
    const choices = (volumes || [v]).filter((candidate) => {
      const mount = mountPoint(candidate);
      return under(p, mount) || under(p, candidate.path) || under(p, candidate.root);
    });
    choices.sort((a, b) => mountPoint(b).length - mountPoint(a).length);
    return choices.length ? choices[0].name === v.name : false;
  }

  function lineBelongs(line, v, volumes) {
    return belongs(line.trim(), v, volumes);
  }

  /** Roles are read from the text boxes, so the boxes and the cards cannot disagree. */
  function rolesFor(volumes, srcLines, destLines) {
    const roles = {};
    for (const v of volumes) {
      roles[v.name] = {
        source: srcLines.some((l) => belongs(l, v, volumes)),
        destination: destLines.some((l) => belongs(l, v, volumes)),
      };
    }
    return roles;
  }

  /**
   * What one role button shows and does.
   * action: "add" | "clear" | "none". A blocked button stays focusable (aria-disabled)
   * and says why in its label.
   */
  function buttonState(v, role, roles, locked) {
    const other = role === "source" ? "destination" : "source";
    const mine = roles[v.name] || { source: false, destination: false };
    const word = role === "source" ? "Source" : "Destination";
    if (locked) {
      return {
        label: mine[role] ? `Selected as ${role}` : word,
        action: "none",
        blocked: true,
        pressed: !!mine[role],
        reason: "Locked while a job is running",
      };
    }
    if (mine[role]) {
      return {
        label: `Clear ${role}`,
        action: "clear",
        blocked: false,
        pressed: true,
        reason: "",
      };
    }
    if (mine[other]) {
      return {
        label: `Selected as ${other}`,
        action: "none",
        blocked: true,
        pressed: false,
        reason: `Selected as ${other}`,
      };
    }
    const rule = v[role] || { allowed: true, reason: "" };
    if (!rule.allowed) {
      return { label: word, action: "none", blocked: true, pressed: false, reason: rule.reason };
    }
    return { label: word, action: "add", blocked: false, pressed: false, reason: "" };
  }

  function addLine(text, p) {
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!lines.includes(p)) lines.push(p);
    return lines.join("\n");
  }

  /** Remove only the lines that belong to this volume; every other line stays. */
  function clearLines(text, v, volumes) {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((l) => !lineBelongs(l, v, volumes))
      .join("\n");
  }

  /** Put a chosen folder in place of the volume's own root line, or add it. */
  function chooseFolderLine(text, v, folder) {
    const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const at = lines.findIndex((l) => l === v.path || l === v.root);
    if (at >= 0) lines[at] = folder;
    else if (!lines.includes(folder)) lines.push(folder);
    return lines.join("\n");
  }

  function spaceLabel(scan) {
    return scan && scan.partial ? "Counted so far (partial)" : "Planned (upper bound)";
  }

  return { belongs, rolesFor, buttonState, addLine, clearLines, chooseFolderLine, spaceLabel, under, parentOf };
});
