"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {restoreFinishedJobs}=require("./history");
test("history preserves only known settings and never promotes engine pass done to job done",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"ditcopy-test-b2p1-history-"));
 const write=(name,events)=>fs.writeFileSync(path.join(dir,name+".jsonl"),events.map(e=>typeof e==="string"?e:JSON.stringify(e)).join("\n")+"\n");
 write("old-verify",[{type:"start",mode:"verify-only"},{type:"done",ok:true}]);
 write("old-pass1",[{type:"start"},{type:"done",ok:true}]);
 write("interrupted",[{type:"job_created",metadata:{src:["/src"],dest:["/dest"],mode:"force"}},{type:"start"},{type:"progress",copied_bytes:1}]);
 write("cancelled",[{type:"job_created",metadata:{mode:"force",src:["/x"],dest:["/y"]}},{type:"start"},{type:"job_finished",status:"cancelled"}]);
 write("released",[{type:"job_created",metadata:{mode:"force",src:["/x"],dest:["/y"]}},{type:"job_resumed",resumedBy:"resume-1"},{type:"job_resume_released",resumedBy:"resume-1"},{type:"job_finished",status:"paused"}]);
 write("good",[{type:"job_created",metadata:{mode:"diff",verify:false,hash:"sha256",dest:["/a","/b"]}},{type:"start"},"{malformed",{type:"done",ok:true},{type:"job_finished",status:"done",reports:{html:"report.html"}}]);
 const jobs=new Map(),warnings=[];restoreFinishedJobs(dir,jobs,s=>warnings.push(s));
 assert.equal(jobs.get("old-verify").mode,"verify-only");assert.equal(jobs.get("old-verify").verify,null);assert.equal(jobs.get("old-verify").hash,null);
 assert.equal(jobs.get("old-pass1").src,null);assert.equal(jobs.get("old-pass1").dest,null);assert.equal(jobs.get("old-pass1").mode,null);assert.equal(jobs.get("old-pass1").cascade,null);assert.equal(jobs.get("old-pass1").status,"incomplete");
 assert.equal(jobs.get("interrupted").status,"incomplete");assert.equal(jobs.get("interrupted").src[0],"/src");assert.equal(jobs.get("cancelled").status,"cancelled");
 assert.equal(jobs.get("released").resumedBy,null);assert.equal(jobs.get("good").status,"done");assert.equal(jobs.get("good").verify,false);assert.equal(jobs.get("good").hash,"sha256");assert.equal(jobs.get("good").reports.html,"report.html");assert.equal(jobs.size,6);
 assert.match(warnings[0],/good.jsonl:3/);
});
