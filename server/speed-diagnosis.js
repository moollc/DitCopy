'use strict';
const key=p=>String(p).replace(/^\/private\/tmp\//,'/tmp/').replace(/\/$/,'');
function diagnosis(job,fmtBytes){const samples=job.speedSamples||[],dest=job.dest||[];
 const drops=dest.map(destination=>{const rates=samples.map((sample,index)=>{const item=(sample.destinations||[]).find(d=>key(d.destination)===key(destination));return item&&(!Object.hasOwn(sample,'phase')||sample.phase==='copying')?{index,bytes:item.bytes,rate:Number(item.speedBps)||0}:null;}).filter(Boolean).filter((sample,index,all)=>index===0||sample.bytes>all[index-1].bytes);
 if(rates.length<3||rates[0].rate<=0||rates.at(-1).rate>=rates[0].rate*.65)return null;
 const sharp=rates.findIndex((r,i)=>i>0&&r.rate<rates[i-1].rate*.55);
 const onset=sharp>0?rates[sharp]:rates.find(r=>r.rate<rates[0].rate*.65);
 return {destination,sharp:sharp>0,index:onset?.index,bytes:onset?.bytes};});
 let cause='No sustained speed drop in the recorded samples.';
 const falling=drops.filter(Boolean);
 if(dest.length>1&&falling.length===dest.length&&Math.max(...falling.map(d=>d.index))-Math.min(...falling.map(d=>d.index))<=1){cause='All destinations slowed together. A shared cause is possible: the source, the computer, or one physical disk holding both destinations.';}
 else if(falling.length>1&&Math.max(...falling.map(d=>d.index))-Math.min(...falling.map(d=>d.index))<=1){cause=`${falling.map(d=>d.destination).join(', ')} slowed together. A shared source, computer, or physical disk is a possible cause; other destinations did not show this fall.`;}
 else if(falling.length){const d=falling[0];const failed=(job.destination_results||Object.values(job.destinationResults||{})).some(s=>key(s.destinationId)===key(d.destination)&&s.status==='failed');cause=failed?`${d.destination}: copying stopped after a destination error; the samples do not identify a cache or heat cause.`:d.sharp?`${d.destination}: sharp fall near ${fmtBytes(d.bytes)}; a filling drive write cache is a possible cause.`:`${d.destination}: gradual sustained fall; heat is a possible cause.`;}
 return [...(job.driveLinks||[]).filter(d=>d.warning).map(d=>`${d.destination}: ${d.warning}`),cause].join(' ');
}
function describeLinks(links){return links.length?links.map(d=>`${d.destination}: ${d.type}${d.detail?` (${d.detail})`:''}${d.warning?`; ${d.warning}`:''}`).join('\n'):'Link speed unknown; no drive discovery result.';}
module.exports={diagnosis,describeLinks};
