"use strict";
// Refuses requests that did not come from the local UI: a wrong Host header (DNS rebinding)
// or, on anything that changes state, an Origin that is not this server.
function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
}

function checkRequest(req, port) {
  const hosts = allowedHosts(port);
  if (!hosts.has(String(req.headers.host || "").toLowerCase())) return "bad host";
  const method = req.method || "GET";
  if (method === "GET" || method === "HEAD") return null;
  const origin = req.headers.origin;
  if (origin === undefined) return null; // curl, the MCP tools and the native shell send none
  if (!hosts.has(String(origin).replace(/^http:\/\//i, "").toLowerCase())) return "bad origin";
  return null;
}

module.exports = { checkRequest };
