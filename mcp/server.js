#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ENGINE = path.join(ROOT, "engine", "target", "release", "ditcopy_engine");
const JOBS_DIR = path.join(ROOT, "jobs");
const PRESETS_DIR = path.join(ROOT, "presets");
const LOGS_DIR = path.join(ROOT, "logs");
const REPORTS_DIR = path.join(LOGS_DIR, "reports");
const API = `http://127.0.0.1:${process.env.DITCOPY_PORT || 34826}`;
const require = createRequire(import.meta.url);
const volumes = require("../server/volumes.js");

/** @type {Map<string, object>} */
const localJobs = new Map();
let lastReport = null;

function httpJson(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(apiPath, API);
    const payload = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
        timeout: 8000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let data;
          try {
            data = text ? JSON.parse(text) : {};
          } catch {
            data = { raw: text };
          }
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(data.error || `HTTP ${res.statusCode}`));
          } else {
            resolve(data);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiHealthy() {
  try {
    const h = await httpJson("GET", "/api/health");
    return !!(h && h.ok);
  } catch {
    return false;
  }
}

function listVolumesLocal() {
  return volumes.listVolumes({ appDir: ROOT });
}

function makeJobId() {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function runEngine(args) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(ENGINE)) {
      return reject(new Error(`engine missing: ${ENGINE}`));
    }
    const child = spawn(ENGINE, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const events = [];
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          events.push(JSON.parse(t));
        } catch {
          events.push({ type: "raw", line: t });
        }
      }
      resolve({ code, stderr, events, stdout });
    });
  });
}

function jobPayloadFromArgs(args) {
  return {
    src: args.src,
    dest: args.dest,
    mode: args.mode || "force",
    verify: args.verify !== false,
    perfectVerify: !!args.perfectVerify,
    hash: args.hash || "xxh3",
    include: args.include || "",
    exclude: args.exclude || "",
    minSize: args.minSize != null ? args.minSize : null,
    maxSize: args.maxSize != null ? args.maxSize : null,
    fromDate: args.fromDate || null,
    toDate: args.toDate || null,
    speed: args.speed || "full",
    diskMode: args.diskMode || "auto",
    nonstop: args.nonstop !== false,
    confirm: !!args.confirm,
    cascade: !!args.cascade,
    writeMhl: !!args.writeMhl,
    writeReport: !!args.writeReport,
    keepAwake: !!args.keepAwake,
    resumeFrom: args.resumeFrom || null,
    jobName: args.jobName || null,
    volumeBindings: Array.isArray(args.volumeBindings) ? args.volumeBindings : [],
  };
}

async function spawnLocalJob(payload) {
  const entries = await volumes.loadDf({ refresh: true });
  const validation = volumes.validateStart(payload, { appDir: ROOT, entries, requireVolumeBindings: true });
  if (validation.errors.length) throw new Error(validation.errors.join(". "));
  const id = makeJobId();
  const args = ["copy"];
  for (const s of payload.src) args.push("--src", s);
  for (const d of payload.dest) args.push("--dest", d);
  args.push("--mode", payload.mode || "force");
  args.push("--verify", payload.verify === false ? "false" : "true");
  if (payload.nonstop) args.push("--nonstop");
  if (payload.confirm) args.push("--confirm");
  args.push("--job-id", id);

  const job = {
    id,
    status: "running",
    ...payload,
    events: [],
    summary: null,
    error: null,
    child: null,
  };
  localJobs.set(id, job);

  const child = spawn(ENGINE, args, {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  job.child = child;
  job.pid = child.pid;
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        job.events.push(ev);
        if (ev.type === "done") job.summary = ev;
      } catch {
        job.events.push({ type: "raw", line });
      }
    }
  });
  child.on("close", (code) => {
    job.child = null;
    job.exitCode = code;
    if (job.status !== "cancelled") {
      job.status = code === 0 ? "done" : "error";
      if (code !== 0 && !job.error) job.error = `exit ${code}`;
    }
  });
  child.on("error", (err) => {
    job.status = "error";
    job.error = err.message;
  });
  return { id, status: job.status };
}

function sanitizeName(name) {
  return String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function estimatePaths(srcList) {
  // Counted in Node, not with find and du, so it works the same on macOS, Linux and Windows.
  const sources = (srcList || []).filter(Boolean);
  if (!sources.length) throw new Error("src required");
  const scan = await volumes.scanSources(sources, { maxEntries: 5000000, maxMs: 120000 });
  const files = scan.sources.reduce((sum, x) => sum + x.files, 0);
  const bytes = scan.sources.reduce((sum, x) => sum + x.bytes, 0);
  const errors = scan.partial ? ["the scan stopped early, so these totals are a lower bound"] : [];
  return { files, bytes, errors, sources };
}

function textResult(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

const startJobProps = {
  src: { type: "array", items: { type: "string" } },
  dest: { type: "array", items: { type: "string" } },
  mode: {
    type: "string",
    enum: [
      "force",
      "noexist",
      "diff",
      "newer",
      "sync",
      "move",
      "delete",
      "verify-only",
    ],
  },
  verify: { type: "boolean" },
  perfectVerify: { type: "boolean" },
  hash: { type: "string", enum: ["xxh3", "xxh64", "md5", "sha256"] },
  include: { type: "string" },
  exclude: { type: "string" },
  minSize: { type: ["number", "null"] },
  maxSize: { type: ["number", "null"] },
  fromDate: { type: ["string", "null"] },
  toDate: { type: ["string", "null"] },
  speed: { type: "string" },
  diskMode: { type: "string", enum: ["auto", "same", "diff"] },
  nonstop: { type: "boolean" },
  confirm: { type: "boolean" },
  cascade: { type: "boolean" },
  writeMhl: { type: "boolean" },
  writeReport: { type: "boolean" },
  keepAwake: { type: "boolean" },
  resumeFrom: { type: ["string", "null"] },
  jobName: { type: ["string", "null"] },
};

const server = new Server(
  { name: "ditcopy", version: "0.2.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_volumes",
      description: "List mounted drives with free bytes when available",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "start_job",
      description:
        "Start a DitCopy multi-dest job (Phase 2+3 fields). Destructive modes need confirm:true.",
      inputSchema: {
        type: "object",
        properties: startJobProps,
        required: ["src", "dest"],
        additionalProperties: false,
      },
    },
    {
      name: "list_jobs",
      description: "List known DitCopy jobs",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "job_status",
      description: "Get job detail and events by id",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    {
      name: "cancel_job",
      description: "Cancel a running job",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    {
      name: "verify_paths",
      description: "Run verify-only of src vs dest without copying",
      inputSchema: {
        type: "object",
        properties: {
          src: { type: "array", items: { type: "string" } },
          dest: { type: "array", items: { type: "string" } },
          nonstop: { type: "boolean" },
          hash: { type: "string" },
        },
        required: ["src", "dest"],
        additionalProperties: false,
      },
    },
    {
      name: "save_job",
      description: "Save a named job definition under DitCopy/jobs/",
      inputSchema: {
        type: "object",
        properties: { ...startJobProps, name: { type: "string" } },
        required: ["name", "src", "dest"],
        additionalProperties: false,
      },
    },
    {
      name: "list_saved_jobs",
      description: "List saved job JSON files",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "run_saved_job",
      description: "Start a job from a saved name (optional field overrides)",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          confirm: { type: "boolean" },
          dest: { type: "array", items: { type: "string" } },
          src: { type: "array", items: { type: "string" } },
        },
        required: ["name"],
        additionalProperties: true,
      },
    },
    {
      name: "list_presets",
      description: "List DitCopy/presets/*.json",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "apply_preset",
      description:
        "Return preset JSON; if dest (and optional src) provided, start a job from the preset",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          src: { type: "array", items: { type: "string" } },
          dest: { type: "array", items: { type: "string" } },
          confirm: { type: "boolean" },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "generate_report",
      description: "Fetch report paths/URLs for a job id (server writes reports on job done)",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    {
      name: "seal_mhl",
      description: "Return MHL paths from a completed job (written when writeMhl was true)",
      inputSchema: {
        type: "object",
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
        additionalProperties: false,
      },
    },
    {
      name: "get_last_report",
      description: "Return the most recently fetched/generated report info from this MCP session",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "estimate_job",
      description: "Estimate file count and bytes for source paths via find/du",
      inputSchema: {
        type: "object",
        properties: {
          src: { type: "array", items: { type: "string" } },
        },
        required: ["src"],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};

  try {
    if (name === "list_volumes") {
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/volumes");
        return textResult({ via: "api", volumes: data.volumes });
      }
      const volumes = await listVolumesLocal();
      return textResult({ via: "local", volumes });
    }

    if (name === "start_job") {
      const payload = jobPayloadFromArgs(args);
      if (await apiHealthy()) {
        const data = await httpJson("POST", "/api/jobs", payload);
        return textResult({ via: "api", ...data });
      }
      const data = await spawnLocalJob(payload);
      return textResult({ via: "engine", ...data });
    }

    if (name === "list_jobs") {
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/jobs");
        return textResult({ via: "api", ...data });
      }
      const jobs = [...localJobs.values()].map((j) => ({
        id: j.id,
        status: j.status,
        src: j.src,
        dest: j.dest,
        mode: j.mode,
        summary: j.summary,
      }));
      return textResult({ via: "local", jobs });
    }

    if (name === "job_status") {
      const jobId = args.job_id;
      if (await apiHealthy()) {
        try {
          const data = await httpJson("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
          return textResult({ via: "api", ...data });
        } catch {
          /* fall through */
        }
      }
      const job = localJobs.get(jobId);
      if (!job) return textResult({ error: "job not found", job_id: jobId });
      return textResult({
        via: "local",
        id: job.id,
        status: job.status,
        src: job.src,
        dest: job.dest,
        mode: job.mode,
        events: job.events,
        summary: job.summary,
        error: job.error,
      });
    }

    if (name === "cancel_job") {
      const jobId = args.job_id;
      if (await apiHealthy()) {
        try {
          const data = await httpJson(
            "POST",
            `/api/jobs/${encodeURIComponent(jobId)}/cancel`
          );
          return textResult({ via: "api", ...data });
        } catch {
          /* fall through */
        }
      }
      const job = localJobs.get(jobId);
      if (!job) return textResult({ error: "job not found", job_id: jobId });
      if (job.child) {
        job.status = "cancelled";
        job.child.kill("SIGTERM");
      }
      return textResult({ via: "local", id: job.id, status: job.status });
    }

    if (name === "verify_paths") {
      if (await apiHealthy()) {
        const data = await httpJson("POST", "/api/jobs", {
          src: args.src,
          dest: args.dest,
          mode: "verify-only",
          verify: true,
          nonstop: !!args.nonstop,
          hash: args.hash || "xxh3",
          writeReport: true,
        });
        return textResult({ via: "api", note: "verify-only job started", ...data });
      }
      const cmdArgs = ["verify"];
      for (const s of args.src) cmdArgs.push("--src", s);
      for (const d of args.dest) cmdArgs.push("--dest", d);
      if (args.nonstop) cmdArgs.push("--nonstop");
      const result = await runEngine(cmdArgs);
      return textResult({ via: "engine", ...result });
    }

    if (name === "save_job") {
      const payload = { ...jobPayloadFromArgs(args), name: sanitizeName(args.name) };
      if (await apiHealthy()) {
        const data = await httpJson("POST", "/api/saved-jobs", payload);
        return textResult({ via: "api", ...data });
      }
      fs.mkdirSync(JOBS_DIR, { recursive: true });
      const filePath = path.join(JOBS_DIR, `${payload.name}.json`);
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
      return textResult({ via: "local", name: payload.name, path: filePath });
    }

    if (name === "list_saved_jobs") {
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/saved-jobs");
        return textResult({ via: "api", ...data });
      }
      fs.mkdirSync(JOBS_DIR, { recursive: true });
      const jobs = fs
        .readdirSync(JOBS_DIR)
        .filter((n) => n.endsWith(".json"))
        .map((n) => ({
          name: n.replace(/\.json$/, ""),
          path: path.join(JOBS_DIR, n),
        }));
      return textResult({ via: "local", jobs });
    }

    if (name === "run_saved_job") {
      const savedName = sanitizeName(args.name);
      if (await apiHealthy()) {
        const { name: _n, ...override } = args;
        const data = await httpJson(
          "POST",
          `/api/saved-jobs/${encodeURIComponent(savedName)}/run`,
          override
        );
        return textResult({ via: "api", ...data });
      }
      const filePath = path.join(JOBS_DIR, `${savedName}.json`);
      if (!fs.existsSync(filePath)) {
        return textResult({ error: "saved job not found", name: savedName });
      }
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const payload = jobPayloadFromArgs({ ...saved, ...args });
      payload.requireVolumeBindings = true;
      const data = await spawnLocalJob(payload);
      return textResult({ via: "engine", from: savedName, ...data });
    }

    if (name === "list_presets") {
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/presets");
        return textResult({ via: "api", ...data });
      }
      fs.mkdirSync(PRESETS_DIR, { recursive: true });
      const presets = fs
        .readdirSync(PRESETS_DIR)
        .filter((n) => n.endsWith(".json"))
        .map((n) => {
          const full = path.join(PRESETS_DIR, n);
          return {
            name: n.replace(/\.json$/, ""),
            path: full,
            preset: JSON.parse(fs.readFileSync(full, "utf8")),
          };
        });
      return textResult({ via: "local", presets });
    }

    if (name === "apply_preset") {
      const pname = sanitizeName(args.name);
      let preset;
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/presets");
        const hit = (data.presets || []).find((p) => p.name === pname);
        if (!hit) return textResult({ error: "preset not found", name: pname });
        preset = hit.preset;
      } else {
        const full = path.join(PRESETS_DIR, `${pname}.json`);
        if (!fs.existsSync(full)) return textResult({ error: "preset not found", name: pname });
        preset = JSON.parse(fs.readFileSync(full, "utf8"));
      }

      const destFilled = Array.isArray(args.dest) && args.dest.filter(Boolean).length > 0;
      if (!destFilled) {
        return textResult({ via: "preset", name: pname, preset, started: false });
      }

      const payload = jobPayloadFromArgs({
        ...preset,
        src: args.src && args.src.length ? args.src : preset.src,
        dest: args.dest,
        confirm: !!args.confirm,
      });
      payload.requireVolumeBindings = true;
      if (await apiHealthy()) {
        const data = await httpJson("POST", "/api/jobs", payload);
        return textResult({ via: "api", name: pname, started: true, ...data });
      }
      const data = await spawnLocalJob(payload);
      return textResult({ via: "engine", name: pname, started: true, ...data });
    }

    if (name === "generate_report") {
      const jobId = args.job_id;
      if (await apiHealthy()) {
        const data = await httpJson("GET", `/api/jobs/${encodeURIComponent(jobId)}/report`);
        lastReport = { via: "api", ...data, fetchedAt: new Date().toISOString() };
        return textResult(lastReport);
      }
      const html = path.join(REPORTS_DIR, `${jobId}.html`);
      const txt = path.join(REPORTS_DIR, `${jobId}.txt`);
      lastReport = {
        via: "local",
        id: jobId,
        reports: {
          html: fs.existsSync(html) ? html : null,
          txt: fs.existsSync(txt) ? txt : null,
          mhl: [],
        },
        fetchedAt: new Date().toISOString(),
      };
      return textResult(lastReport);
    }

    if (name === "seal_mhl") {
      const jobId = args.job_id;
      if (await apiHealthy()) {
        const job = await httpJson("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
        const mhl = (job.reports && job.reports.mhl) || [];
        return textResult({ via: "api", job_id: jobId, mhl });
      }
      return textResult({
        error: "API down; MHL is produced by server post-process when writeMhl=true",
        job_id: jobId,
      });
    }

    if (name === "get_last_report") {
      if (lastReport) return textResult(lastReport);
      if (await apiHealthy()) {
        const data = await httpJson("GET", "/api/jobs");
        const jobs = data.jobs || [];
        const withReport = jobs.find((j) => j.reports && (j.reports.html || j.reports.txt));
        if (withReport) {
          lastReport = {
            via: "api",
            id: withReport.id,
            reports: withReport.reports,
            fetchedAt: new Date().toISOString(),
          };
          return textResult(lastReport);
        }
        const htmlDir = REPORTS_DIR;
        if (fs.existsSync(htmlDir)) {
          const htmls = fs
            .readdirSync(htmlDir)
            .filter((f) => f.endsWith(".html"))
            .sort()
            .reverse();
          if (htmls.length) {
            const id = htmls[0].replace(/\.html$/, "");
            lastReport = {
              via: "local-scan",
              id,
              reports: {
                html: path.join(htmlDir, `${id}.html`),
                txt: path.join(htmlDir, `${id}.txt`),
                mhl: [],
              },
              fetchedAt: new Date().toISOString(),
            };
            return textResult(lastReport);
          }
        }
      }
      return textResult({ error: "no report found yet" });
    }

    if (name === "estimate_job") {
      const est = await estimatePaths(args.src);
      return textResult({ via: "find/du", ...est });
    }

    return textResult({ error: `unknown tool: ${name}` });
  } catch (e) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: e.message }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
