"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('./destination-outcomes');
test('completed and failed destinations persist across cascade passes and source aliases',()=>{
 const job={dest:['/tmp/bad','/tmp/good'],nonstop:true};
 D.recordDestinations(job,{type:'destination_error',destination:'/private/tmp/bad',message:'mkdir denied'});
 D.recordDestinations(job,{type:'done',source_errors:0,completed_destinations:[],failed_destinations:{'/tmp/bad':'mkdir denied'},destinationStates:[{destinationId:'/tmp/bad',status:'failed',lastError:'mkdir denied'}]});
 job.summary={ok:false,source_errors:0,failed_destinations:{'/tmp/bad':'mkdir denied'}};
 assert(D.passCanContinue(job,{code:1}));
 D.recordDestinations(job,{type:'done',source_errors:0,completed_destinations:['/tmp/good'],destinationStates:[{destinationId:'/tmp/good',status:'verified',bytesWritten:100,bytesVerified:100}]});
 assert.deepEqual(D.completed(job),['/tmp/good']);assert.equal(D.failures(job)[0].lastError,'mkdir denied');
 assert.match(D.describe(job),/bad: Failed: mkdir denied/);assert.match(D.describe(job),/good: Done/);
});
test('strict destination and all source failures stop cascade',()=>{
 const job={nonstop:false,summary:{ok:false,source_errors:0,failed_destinations:{bad:'denied'}}};assert(!D.passCanContinue(job,{code:1}));
 job.nonstop=true;job.summary.source_errors=1;assert(!D.passCanContinue(job,{code:1}));
});
test('a failure revokes previous completion and cannot be erased by a later snapshot',()=>{
 const job={};D.recordDestinations(job,{type:'done',completed_destinations:['/tmp/a'],destinationStates:[{destinationId:'/tmp/a',status:'copied'}]});
 D.recordDestinations(job,{type:'destination_error',destination:'/tmp/a',message:'verify mismatch'});
 D.recordDestinations(job,{type:'progress',destinationStates:[{destinationId:'/tmp/a',status:'verified'}]});
 assert.deepEqual(D.completed(job),[]);assert.equal(D.failures(job)[0].lastError,'verify mismatch');
});

test('a strict or source abort never labels a partial healthy destination Done',()=>{
 const job={dest:['/tmp/bad','/tmp/good'],progress:{}};
 D.recordDestinations(job,{type:'destination_error',destination:'/tmp/bad',message:'write failed'});
 D.recordDestinations(job,{type:'done',source_errors:0,completed_destinations:[],destinationStates:[{destinationId:'/tmp/good',status:'verified',bytesVerified:10}]});
 D.settle(job);assert.equal(job.destinationResults['/tmp/good'].status,'stopped');assert.equal(job.destinationResults['/tmp/bad'].status,'failed');
});
