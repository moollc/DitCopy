"use strict";
const key = p => String(p).replace(/^\/private(?=\/tmp(?:\/|$))/, "").replace(/\/+$/, "") || "/";
function recordDestinations(job, event) {
  job.destinationResults ||= {};
  job.completedDestinations ||= [];
  for (const state of Array.isArray(event.destinationStates) ? event.destinationStates : []) {
    if (!state || typeof state.destinationId !== "string") continue;
    const id=key(state.destinationId), prior=job.destinationResults[id];
    job.destinationResults[id] = prior?.status === "failed" ? {...state,status:"failed",lastError:prior.lastError} : {...state};
  }
  if (event.type === "destination_error" && event.destination) {
    const id=key(event.destination);
    job.destinationResults[id] = {...job.destinationResults[id],destinationId:event.destination,status:"failed",lastError:event.message};
  }
  if (event.type === "done") {
    job.sourceErrors = (job.sourceErrors || 0) + (Number(event.source_errors) || 0);
    for (const dest of event.completed_destinations || []) if (!job.completedDestinations.some(p=>key(p)===key(dest))) job.completedDestinations.push(dest);
    // Backward compatibility for a clean older engine pass.
    if (!event.completed_destinations && event.ok) for (const state of event.destinationStates || []) {
      if (["verified","copied"].includes(state.status)) job.completedDestinations.push(state.destinationId);
    }
  }
  job.completedDestinations = job.completedDestinations.filter(p=>job.destinationResults[key(p)]?.status!=="failed");
}
function completed(job) { return (job.completedDestinations || []).filter(p=>job.destinationResults?.[key(p)]?.status!=="failed"); }
function failures(job) { return Object.values(job.destinationResults || {}).filter(s=>s.status==="failed"); }
function passCanContinue(job, result) {
  return result.code===0 && job.summary?.ok!==false || !!(job.nonstop && job.summary?.source_errors===0 && Object.keys(job.summary?.failed_destinations || {}).length);
}
function settle(job) {
  const done=new Set(completed(job).map(key));job.destinationResults ||= {};
  for(const dest of job.dest || []) {
    const id=key(dest),state=job.destinationResults[id] || {destinationId:dest,bytesWritten:0,bytesVerified:0,lastError:null};
    if(state.status!=="failed") state.status=done.has(id) ? state.status==="verified" ? "verified" : "copied" : "stopped";
    job.destinationResults[id]=state;
  }
  if(job.progress)job.progress.destination_states=Object.values(job.destinationResults);
}
function describe(job) {
  return (job.dest || []).map(dest=>{
    const state=job.destinationResults?.[key(dest)], done=completed(job).some(p=>key(p)===key(dest));
    return `${dest}: ${state?.status==="failed" ? "Failed: "+(state.lastError || "destination error") : done ? "Done" : "Stopped or incomplete"}`;
  }).join("\n");
}
module.exports = {key, recordDestinations, completed, failures, passCanContinue, describe, settle};
