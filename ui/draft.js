"use strict";
// Remembers the form between visits, in this browser only, so a reload or a closed tab does not lose the sources, destinations
// and options that were typed. A convenience, never the truth: a running job always wins, and storage that is missing, full or
// blocked simply means nothing is remembered. Pure apart from the storage it is given, so it runs under node for the tests.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DitDraft = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const KEY = "ditcopy.form.v1";
  // Never remembered: the destructive confirmation, drive bindings (found again from the drives), and where a resume came from.
  const SKIP = new Set(["confirm", "volumeBindings", "resumeFrom"]);

  function pick(body) {
    const out = {};
    for (const [k, v] of Object.entries(body || {})) if (!SKIP.has(k)) out[k] = v;
    return out;
  }

  function write(storage, body) {
    try {
      storage.setItem(KEY, JSON.stringify({ saved: Date.now(), form: pick(body) }));
      return true;
    } catch {
      return false;
    }
  }

  /** The remembered form as a preset for applyPreset, or null. Without a source or a destination there is nothing to restore. */
  function read(storage) {
    try {
      const raw = storage.getItem(KEY);
      if (!raw) return null;
      const form = JSON.parse(raw).form;
      if (!form || typeof form !== "object") return null;
      const has = (a) => Array.isArray(a) && a.some(Boolean);
      if (!has(form.src) && !has(form.dest)) return null;
      // a mode that deletes or moves is never restored: it must be chosen again on purpose
      if (["sync", "move", "delete"].includes(form.mode)) form.mode = "force";
      return { ...form, name: form.jobName || "" };
    } catch {
      return null;
    }
  }

  return { write, read, pick, KEY };
});
