"use strict";
const volumes = require("./volumes");

function validateLocalJob(payload, appDir, dfText, options = {}) {
  const entries = volumes.parseDf(dfText);
  return volumes.validateStart(payload, {
    appDir,
    entries,
    requireVolumeBindings: true,
  });
}

module.exports = { validateLocalJob };
