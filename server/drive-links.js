'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFile}=require('node:child_process');
function run(file,args,input){return new Promise((resolve,reject)=>{const p=execFile(file,args,{encoding:'utf8',timeout:12000,maxBuffer:8*1024**2},(e,out)=>e?reject(e):resolve(out));if(input!==undefined)p.stdin.end(input);});}
const whole=name=>String(name||'').replace(/^\/dev\//,'').match(/^(disk\d+)(?:s\d+)*$/)?.[1]||null;
// The closest ancestor with its own speed describes this device, never a sibling.
function profilerSpeeds(tree,disk){const found=[];function visit(value,speed){if(!value||typeof value!=='object')return;if(Array.isArray(value)){value.forEach(v=>visit(v,speed));return;}
 const own=value.device_speed||value.speed||value.link_speed||value.current_speed_key;const current=own||speed;
 if(whole(value.bsd_name)===disk&&current)found.push(String(current));
 for(const v of Object.values(value))if(v&&typeof v==='object')visit(v,current);
 }visit(tree,null);return [...new Set(found)];}
function label(speed){if(/480\s*mb\/s|usb\s*2(?:\.0)?|^high_speed$/i.test(speed))return 'USB 2';if(/(?:5|10|20)\s*gb\/s|usb\s*3|^super_speed(?:_plus)?$/i.test(speed))return 'USB 3';return 'link speed unknown';}
function classify(destination,info,apfs,profiler){const device=whole(info.DeviceIdentifier),container=whole(info.APFSContainerReference||info.ParentWholeDisk||device);
 let physical=[];
 if(info.APFSContainerReference||String(info.FilesystemType||'').toLowerCase()==='apfs'){
  const match=(apfs.Containers||[]).find(c=>whole(c.ContainerReference)===container);
  physical=(match?.PhysicalStores||[]).map(p=>whole(p.DeviceIdentifier)).filter(Boolean);
 }else if(device)physical=[whole(info.ParentWholeDisk)||device];
 physical=[...new Set(physical)];const speeds=physical.length===1?profilerSpeeds(profiler,physical[0]):[];
 const protocol=String(info.BusProtocol||info.Protocol||'unknown');
 const type=speeds.length===1?label(speeds[0]):'link speed unknown';
 return {destination,type,detail:type==='link speed unknown'?'':protocol,physicalDisks:physical,warning:type==='USB 2'?'USB 2 link may limit sustained copy speed':null};}
async function probe(paths,command=run){let profiler={},apfs={};
 const plist=async args=>JSON.parse(await command('/usr/bin/plutil',['-convert','json','-o','-','-'],await command('/usr/sbin/diskutil',args)));
 await Promise.all([command('/usr/sbin/system_profiler',['-json','SPUSBDataType','SPThunderboltDataType']).then(s=>{profiler=JSON.parse(s);}).catch(()=>{}),plist(['apfs','list','-plist']).then(v=>{apfs=v;}).catch(()=>{})]);
 return Promise.all(paths.map(async destination=>{try{let ancestor=path.resolve(destination);while(!fs.existsSync(ancestor)&&ancestor!==path.dirname(ancestor))ancestor=path.dirname(ancestor);const df=await command('/bin/df',['-P',ancestor]);
 const device=String(df).trim().split(/\r?\n/).at(-1).trim().split(/\s+/)[0];
 if(!/^\/dev\/disk\d+(?:s\d+)*$/.test(device))throw Error('volume device unavailable');
 const info=await plist(['info','-plist',device]);
 if(info.Error||!info.DeviceIdentifier)throw Error('volume information unavailable');
 return classify(destination,info,apfs,profiler);}catch(e){return {destination,type:'link speed unknown',detail:'',physicalDisks:[],warning:null};}}));}
module.exports={run,whole,profilerSpeeds,classify,probe};
