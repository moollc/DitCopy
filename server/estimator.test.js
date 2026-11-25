"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {estimate, safeEstimate, roundSeconds} = require("./estimator");
const M = 1048576;
const start = (copy=1000,verify=2000,recheck=0) => ({type:"start",mode:"force",work_copy_bytes:copy*M,work_verify_bytes:verify*M,work_recheck_bytes:recheck*M,elapsedMonotonicMs:0});
const progress = (phase,bytes,rate,t,more={}) => ({type:"phase_progress",phase,bytesDone:bytes*M,phaseRateBps:rate*M,elapsedMonotonicMs:t,...more});
const job = events => ({status:"running",events});

test("unknown slow verification stays Learning even at extreme copy throttle",()=>{
 for(const speed of ["full","10","50","autoslow"]){
  const e=estimate({...job([start(),progress("copying",600,400,6000)]),speed});
  assert.equal(e.status,"learning");assert.equal(e.rangeSeconds,null);
  assert.equal(e.phaseRatesBps.verifying_destination,undefined);assert.match(e.label,/not measured/);
 }
});
test("measured slow verify determines a conservative rounded range without double counting copy",()=>{
 const e=estimate(job([start(),progress("copying",600,400,6000),{type:"progress",copied_bytes:600*M,elapsedMonotonicMs:6000},progress("verifying_destination",100,40,11000)]));
 assert.equal(e.remainingByPhase.copying,400*M);assert.equal(e.remainingByPhase.verifying_destination,1900*M);
 assert.equal(e.status,"range");assert(e.rangeSeconds.high>=48);
});
test("skipped recheck does not consume the planned eligible recheck",()=>{
 const events=[start(20,40,20),progress("rechecking_source",120,400,1000,{fileId:"/tmp/src/big.bin"}),{type:"phase",phase:"rechecking_source",status:"completed",fileId:"/tmp/src/big.bin",bytesDone:120*M,elapsedMonotonicMs:1100},{type:"file",path:"src/big.bin",status:"skipped",bytes:120*M}];
 assert.equal(estimate(job(events)).remainingByPhase.rechecking_source,20*M);
});
test("verify only suppressed small file outcomes reduce source recheck without copying",()=>{
 const events=[{...start(0,120,60),mode:"verify-only"}];
 for(let i=0;i<30;i++)events.push({type:"file",path:String(i),status:"verified",bytes:M,verified_bytes:(i+1)*2*M,elapsedMonotonicMs:i*10});
 const e=estimate(job(events));assert.equal(e.remainingByPhase.rechecking_source,30*M);assert.equal(e.remainingByPhase.verifying_destination,60*M);assert.equal(e.remainingByPhase.copying,0);
});
test("failed or skipped file outcomes cannot add work",()=>{
 const events=[start(100,0),{type:"file",status:"error",bytes:90*M},{type:"file",status:"skipped",bytes:90*M}];
 assert.equal(estimate(job(events)).remainingBytes,100*M);
});
test("cascade counts future pass at first start, including three destinations",()=>{
 const e=estimate({...job([start(1000,1000),progress("copying",500,100,6000)]),cascade:true,dest:["a","b","c"]});
 assert.equal(e.remainingByPhase.copying,1500*M);assert.equal(e.remainingByPhase.verifying_destination,3000*M);
});
test("cascade gap cannot be Finishing and done payload closes pass one",()=>{
 const e=estimate({...job([start(1000,1000),progress("copying",500,100,6000),progress("verifying_destination",1000,100,12000),{type:"done",bytes:1000*M,verified_bytes:1000*M,elapsedMonotonicMs:21000}]),engineDone:true,cascade:true,dest:["a","b"]});
 assert.notEqual(e.status,"finishing");assert.equal(e.remainingBytes,2000*M);
});
test("cascade second pass uses actual plan and fresh clock and rates",()=>{
 const e=estimate({...job([start(100,100),{type:"done",bytes:100*M,verified_bytes:100*M,elapsedMonotonicMs:9000},start(100,200),progress("copying",10,100,1000)]),cascade:true,dest:["a","b","c"]});
 assert.equal(e.remainingByPhase.copying,90*M);assert.equal(e.remainingByPhase.verifying_destination,200*M);assert.equal(e.status,"learning");
});
test("ordinary path or error text never resets a learned range",()=>{
 const events=[start(900,0),progress("copying",300,50,9000),{type:"error",message:"mkdir /Volumes/CARD/Waiting Room/resume: denied",elapsedMonotonicMs:9500}];
 assert.equal(estimate(job(events)).status,"range");
});
test("heartbeats with no byte movement suspend range and explain device wait",()=>{
 const e=estimate(job([start(900,0),progress("copying",300,50,9000),{type:"heartbeat",phase:"copying",bytesDone:300*M,phaseRateBps:0.0001,elapsedMonotonicMs:20000}]));
 assert.equal(e.status,"waiting");assert.equal(e.rangeSeconds,null);assert.match(e.label,/device/);assert.equal(e.phaseRatesBps.copying,50*M);
});
test("movement after device wait relearns without stale whole-phase rates",()=>{
 const events=[start(900,0),progress("copying",300,50,9000),{type:"heartbeat",phase:"copying",bytesDone:300*M,elapsedMonotonicMs:20000},progress("copying",330,50,21000)];
 const e=estimate(job(events));assert.equal(e.status,"learning");assert.equal(e.rangeSeconds,null);
});
test("real server reset discards prior rate samples",()=>{
 const e=estimate(job([start(900,0),progress("copying",300,50,9000),{type:"estimator_reset",reason:"resume",elapsedMonotonicMs:9500},progress("copying",330,50,9700)]));
 assert.equal(e.status,"learning");
});
test("small file aggregate cycles leave Learning after time and byte gates",()=>{
 const events=[{...start(600,1200,600),work_bytes:2400*M}];
 for(let i=1;i<=30;i++)events.push({type:"file",status:"copied",path:String(i),bytes:4*M,verified_bytes:i*8*M,elapsedMonotonicMs:i*200});
 events.push({type:"progress",speed_bps:20*M,copied_bytes:120*M,verified_bytes:240*M,elapsedMonotonicMs:6000});
 const e=estimate(job(events));assert.equal(e.status,"range");assert.match(e.label,/aggregate/);assert.equal(e.remainingByPhase.rechecking_source,480*M);
});
test("sub five second small jobs correctly remain Learning",()=>{
 const e=estimate(job([start(600,0),{type:"progress",speed_bps:100*M,copied_bytes:500*M,elapsedMonotonicMs:1000}]));assert.equal(e.status,"learning");
});
test("authoritative hidden phase counters and measured rates support small files",()=>{
 const e=estimate(job([start(600,1200,600),{type:"progress",elapsedMonotonicMs:6000,workDoneByPhase:{copying:120*M,rechecking_source:120*M,verifying_destination:240*M},workRatesBps:{copying:20*M,rechecking_source:40*M,verifying_destination:30*M}}]));
 assert.equal(e.status,"range");assert.equal(e.remainingByPhase.rechecking_source,480*M);assert.equal(e.phaseRateSource.verifying_destination,"measured");
});
test("Finishing only after final engine pass; terminal is complete",()=>{
 assert.equal(estimate({...job([]),engineDone:true}).status,"finishing");assert.equal(estimate({...job([]),engineDone:true}).label,"Finishing reports…");assert.equal(estimate({status:"done",events:[]}).status,"complete");
});
test("guard catches malformed shape and logs once",()=>{
 const malformed={id:"bad",events:[start(900,0),{type:"file",status:"skipped",path:null},progress("copying",300,50,9000)]};
 Object.defineProperty(malformed,"cascade",{get(){throw Error("bad shape");}});
 const logs=[];assert.equal(safeEstimate(malformed,0,s=>logs.push(s)),null);assert.equal(safeEstimate(malformed,0,s=>logs.push(s)),null);assert.equal(logs.length,1);
});
test("readable buckets",()=>{assert.equal(roundSeconds(13),15);assert.equal(roundSeconds(121),120);});


test("sustained rates more than forty percent off for ten seconds widen the range",()=>{
 const events=[start(100000,0),progress("copying",300,50,9000)];
 for(let t=10000;t<=19000;t+=1000) events.push(progress("copying",300+(t-9000)/1000*10,10,t));
 assert.equal(estimate(job(events)).relearningReason,undefined);
 events.push(progress("copying",410,10,20000));
 const changed=estimate(job(events));assert.equal(changed.status,"range");assert.equal(changed.relearningReason,"sustained performance change");
 assert.match(changed.label,/relearning/);assert(changed.rangeSeconds.high>=3*changed.rangeSeconds.low);
 assert.equal(changed.phaseRatesBps.copying,10*M);
});
test("transient rate changes do not widen a settled estimate",()=>{
 const events=[start(100000,0),progress("copying",300,50,9000),progress("copying",310,10,10000),progress("copying",360,50,11000),progress("copying",410,50,21000)];
 assert.equal(estimate(job(events)).relearningReason,undefined);
});
test("device and configuration changes are observed on real server binding data",()=>{
 const {observeEstimatorBinding}=require("./estimator-signals");
 const current={...job([start(100000,0),progress("copying",300,50,9000)]),src:["/tmp/source"],dest:["/tmp/dest"],speed:"full"};
 let dev=1;const stat=()=>({dev});
 assert.equal(observeEstimatorBinding(current,0,stat),null);
 current.speed="10";const config=observeEstimatorBinding(current,1,stat);assert.equal(config.reason,"configuration_changed");
 current.events.push(config);assert.equal(estimate(current).status,"learning");
 dev=2;const device=observeEstimatorBinding(current,2,stat);assert.equal(device.reason,"device_changed");
 current.events.push(device);assert.equal(estimate(current).status,"learning");
 assert.equal(observeEstimatorBinding(current,3,stat),null);
});

test("recent byte deltas detect sustained change despite a stale cumulative phase rate",()=>{
 const events=[start(100000,0),progress("copying",300,50,9000)];
 for(let t=10000;t<=20000;t+=1000)events.push(progress("copying",300+(t-9000)/1000*10,50,t,{workRatesBps:{copying:50*M}}));
 const changed=estimate(job(events));assert.equal(changed.relearningReason,"sustained performance change");assert.equal(changed.phaseRatesBps.copying,10*M);
});
