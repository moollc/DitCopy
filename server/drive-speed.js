'use strict';
const fs=require('node:fs'),path=require('node:path'),{run}=require('./drive-links');
async function testDriveSpeed(mount,jobId,engine,command=run){const file=path.join(mount,`.ditcopy-speed-probe-${jobId}.tmp`);try{return JSON.parse(await command(engine,['probe-drive','--dest',mount,'--probe-id',jobId]));}catch(e){return {destination:mount,error:e.message};}finally{try{await fs.promises.unlink(file);}catch(e){if(e.code!=='ENOENT'){} }}}
module.exports={testDriveSpeed};
