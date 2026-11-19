import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBundle, verifyBundle, restoreBundle, restoreDrillDatabase, captureStorage } from '../tools/security-recovery.mjs';
const passphrase='synthetic recovery passphrase for tests only';
const database=Buffer.from('PGDMP synthetic database private bytes');
const withRoot=fn=>async()=>{const root=await mkdtemp(join(tmpdir(),'nordla-recovery-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}};
const make=root=>createBundle({directory:join(root,'bundle'),passphrase,database,files:[{path:'storage/finance-inbox/merchant-a/original.pdf',data:Buffer.from('%PDF- synthetic original')}]});
test('bundle encrypts database, names and originals, then restores exact bytes',withRoot(async root=>{
 await make(root);const directory=join(root,'bundle');
 for(const file of await readdir(directory)){const bytes=await readFile(join(directory,file));for(const secret of ['private bytes','original.pdf','%PDF- synthetic'])assert.equal(bytes.includes(Buffer.from(secret)),false);}
 assert.equal((await verifyBundle({directory,passphrase})).files,1);let db;
 await restoreBundle({directory,passphrase,targetDirectory:join(root,'restored'),restoreDatabase:async bytes=>{db=bytes;}});
 assert.deepEqual(db,database);assert.equal(await readFile(join(root,'restored/storage/finance-inbox/merchant-a/original.pdf'),'utf8'),'%PDF- synthetic original');
}));
test('wrong key and tampering refuse before any database or file write',withRoot(async root=>{
 await make(root);const directory=join(root,'bundle');let calls=0;
 const restore=pw=>restoreBundle({directory,passphrase:pw,targetDirectory:join(root,'restored'),restoreDatabase:async()=>{calls++;}});
 await assert.rejects(restore('wrong synthetic passphrase which is long'),/AUTHENTICATION_FAILED/);
 const file=join(directory,'record-000001.enc');const data=await readFile(file);data[15]^=1;await writeFile(file,data);
 await assert.rejects(restore(passphrase),/AUTHENTICATION_FAILED/);assert.equal(calls,0);await assert.rejects(readdir(join(root,'restored')),{code:'ENOENT'});
}));
test('restore never overwrites; capture refuses escaping and duplicate paths',withRoot(async root=>{
 await make(root);const target=join(root,'occupied');await mkdir(target);await writeFile(join(target,'existing'),'intact');let calls=0;
 await assert.rejects(restoreBundle({directory:join(root,'bundle'),passphrase,targetDirectory:target,restoreDatabase:async()=>{calls++;}}),/TARGET_NOT_EMPTY/);
 assert.equal(calls,0);assert.equal(await readFile(join(target,'existing'),'utf8'),'intact');
 for(const [i,path]of ['../outside','a/../../outside','C:/outside','a\\..\\outside','a//b'].entries())await assert.rejects(createBundle({directory:join(root,'unsafe-'+i),passphrase,database,files:[{path,data:Buffer.from('x')}]}),/PATH_UNSAFE/);
 await assert.rejects(createBundle({directory:join(root,'duplicate'),passphrase,database,files:[{path:'same',data:Buffer.from('1')},{path:'same',data:Buffer.from('2')}]}),/DUPLICATE_PATH/);
}));
test('database restore refuses remote and non-drill targets before any command',async()=>{
 for(const connection of ['postgresql://test:synthetic@remote.example/nordla_recovery_test','postgresql://test:synthetic@127.0.0.1/ordinary_database'])await assert.rejects(restoreDrillDatabase({connection,data:database,env:{NORDLA_RECOVERY_LOCAL_DRILL:'1'}}),/REMOTE_RESTORE_REFUSED/);
});
test('storage capture keeps credentials out of URLs and preserves original bytes',async()=>{
 const calls=[];const files=await captureStorage({url:'https://storage.example',key:'synthetic-private-key',fetchImpl:async(url,options)=>{calls.push({url,options});return options.method==='POST'?Response.json([{id:'synthetic-object',name:'merchant-a/original.pdf',metadata:{size:9}}]):new Response(Buffer.from('%PDF-test'));}});
 assert.equal(files.length,1);assert.equal(files[0].data.toString(),'%PDF-test');assert.equal(files[0].path,'storage/finance-inbox/merchant-a/original.pdf');
 assert.ok(calls.every(c=>!c.url.includes('synthetic-private-key')));assert.ok(calls.every(c=>c.options.headers.Authorization==='Bearer synthetic-private-key'));
});

test('capture and restore refuse a regular file as a target before database effects',withRoot(async root=>{
 const occupied=join(root,'file-target');await writeFile(occupied,'keep');
 await assert.rejects(createBundle({directory:occupied,passphrase,database}),/TARGET_UNSAFE/);
 await make(root);let calls=0;await assert.rejects(restoreBundle({directory:join(root,'bundle'),passphrase,targetDirectory:occupied,restoreDatabase:async()=>{calls++;}}),/TARGET_UNSAFE/);assert.equal(calls,0);assert.equal(await readFile(occupied,'utf8'),'keep');
}));
