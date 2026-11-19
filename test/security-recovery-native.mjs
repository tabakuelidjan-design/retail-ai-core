// Real PostgreSQL 17 drill. No remote DB; all four businesses, records and PDF bytes are synthetic.
import {execFile,spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {createBundle,restoreBundle,dumpDatabase,restoreDrillDatabase,verifyBundle} from '../tools/security-recovery.mjs';
const native=resolve(process.argv[2]);const{default:pg}=await import(pathToFileURL(resolve(process.argv[3])).href);
const root=await mkdtemp(join(tmpdir(),'nordla-native-recovery-'));const data=join(root,'cluster');
const binary=n=>join(native,'bin',n+(process.platform==='win32'?'.exe':''));
const command=(file,args,env=process.env)=>new Promise((yes,no)=>execFile(file,args,{env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024},(e,out,err)=>e?no(new Error('native command failed: '+file.split(/[\\/]/).pop()+': '+err.slice(-180))):yes(out)));
const control=(args)=>new Promise((yes,no)=>{const child=spawn(binary('pg_ctl'),args,{env:process.env,windowsHide:true,stdio:'ignore'});const timer=setTimeout(()=>{child.kill();no(new Error('PostgreSQL control timeout'));},30000);child.on('error',e=>{clearTimeout(timer);no(e);});child.on('exit',code=>{clearTimeout(timer);code===0?yes():no(new Error('PostgreSQL control failed'));});});
const sourceName='nordla_recovery_source',targetName='nordla_recovery_target';
const password=randomBytes(24).toString('base64url'),passphrase=randomBytes(32).toString('base64url'),pwFile=join(root,'init-password');
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const conn=db=>'postgresql://postgres:'+encodeURIComponent(password)+'@127.0.0.1:'+port+'/'+db;
const connect=async db=>{const c=new pg.Client({connectionString:conn(db),connectionTimeoutMillis:10000});await c.connect();return c;};
const clientRoot=process.argv[4]?resolve(process.argv[4]):native;
const clientBinary=n=>join(clientRoot,'bin',n+(process.platform==='win32'?'.exe':''));
const env={...process.env,NORDLA_PG_DUMP:clientBinary('pg_dump'),NORDLA_PG_RESTORE:clientBinary('pg_restore'),NORDLA_PSQL:clientBinary('psql'),NORDLA_RECOVERY_LOCAL_DRILL:'1'};
let started=false,admin,source,restored;const checks=[];const before=Date.now();
try{
 await writeFile(pwFile,password,{mode:0o600});
 await command(binary('initdb'),['-D',data,'-U','postgres','--auth-host=scram-sha-256','--auth-local=trust','--pwfile',pwFile,'--encoding=UTF8','--no-locale']);await rm(pwFile);
 await control(['-D',data,'-l',join(root,'postgres.log'),'-o','-h 127.0.0.1 -p '+port+' -F','-w','start']);started=true;
 admin=await connect('postgres');await admin.query('create database '+sourceName);await admin.query('create database '+targetName);source=await connect(sourceName);
 await source.query([
 'create role anon nologin nobypassrls;create role authenticated nologin nobypassrls;create role service_role nologin bypassrls;',
 'create schema extensions;create extension pgcrypto schema extensions;',
 "create schema auth;create table auth.users(id uuid primary key default gen_random_uuid(),email text,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz,raw_app_meta_data jsonb default '{}',raw_user_meta_data jsonb default '{}',created_at timestamptz default now(),updated_at timestamptz default now());",
 'create table auth.mfa_factors(id uuid primary key default gen_random_uuid(),user_id uuid references auth.users(id),status text,factor_type text,friendly_name text,created_at timestamptz default now(),updated_at timestamptz default now());',
 "create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
 'create schema storage;create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);',
 'grant usage on schema public,extensions,auth to anon,authenticated,service_role;grant execute on all functions in schema extensions to anon,authenticated,service_role;',
 'alter default privileges in schema public grant all on tables to anon,authenticated,service_role;alter default privileges in schema public grant all on sequences to anon,authenticated,service_role;alter default privileges in schema public grant execute on functions to anon,authenticated,service_role;'
 ].join('\n'));
 const repo=fileURLToPath(new URL('../',import.meta.url));
 const listed=(await command('git',['ls-tree','-r','--name-only','054bab81','supabase/migrations'])).trim().split(/\r?\n/);
 for(const file of listed){const sql=await command('git',['show','054bab81:'+file]);try{await source.query(sql);}catch(e){throw new Error('migration '+file.split('/').pop()+': '+e.message);}}
 for(const file of ['20261006090000_finance_belgium_peppol.sql','20261119150000_security_client_tenant_guards.sql'])await source.query(await readFile(join(repo,'supabase/migrations',file),'utf8'));
 assert.equal(listed.length,48);checks.push('50 pinned Nordla migrations replayed');
 const merchants=Array.from({length:4},()=>randomUUID());const files=[];
 for(const[i,m]of merchants.entries()){
  await source.query("insert into public.merchants(id,name,source_system,source_id) values($1,$2,'shopify',$3)",[m,'Synthetic business '+i,'synthetic-'+i]);
  const gross=12100*(i+1),net=10000*(i+1);
  const doc=(await source.query("insert into fin_documents(merchant_id,doc_type,status,currency,issue_date,due_date,net_cents,vat_cents,gross_cents,revenue_basis,body) values($1,'invoice','DRAFT','EUR','2026-11-19','2026-12-19',$2,$3,$4,'standalone_b2b','{\"lines\":[1]}') returning *",[m,net,gross-net,gross])).rows[0];
  await source.query('select fin_issue_document($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[m,doc.id,doc.version,'ISSUED','INV',4,'{prefix}-{year}-{seq}',2026,JSON.stringify({id:doc.id,number:'__NUMBER_PLACEHOLDER__',gross}),'__NUMBER_PLACEHOLDER__','2026-11-19T12:00:00Z',JSON.stringify({actor:{type:'merchant'},action:'ISSUED',detail:{n:'__NUMBER_PLACEHOLDER__'}})]);
  files.push({path:'storage/finance-inbox/'+m+'/original.pdf',data:Buffer.from('%PDF-1.7\nSynthetic original '+i)});
  await source.query("insert into storage.objects(bucket_id,name) values('finance-inbox',$1)",[m+'/original.pdf']);
 }
 checks.push('four merchants, four numbered locked invoices, four originals');
 const amounts="select merchant_id::text,number,net_cents::text,vat_cents::text,gross_cents::text,snapshot_hash from fin_documents order by merchant_id";
 const snapshot=(await source.query(amounts)).rows;
 const dump=await dumpDatabase({connection:conn(sourceName),env});assert.equal(dump.subarray(0,5).toString(),'PGDMP');
 const bundle=join(root,'bundle');await createBundle({directory:bundle,passphrase,database:dump,files});checks.push('database and originals encrypted together');
 await source.query("insert into fin_companies(merchant_id,name) values($1,'Synthetic change after capture')",[merchants[1]]);
 const liveBefore=(await source.query('select count(*)::int n from fin_companies')).rows[0].n;
 await restoreBundle({directory:bundle,passphrase,targetDirectory:join(root,'restored-files'),restoreDatabase:data=>restoreDrillDatabase({connection:conn(targetName),data,env})});restored=await connect(targetName);
 assert.deepEqual((await restored.query(amounts)).rows,snapshot);checks.push('numbers, VAT, totals and document hashes survive pg_dump/pg_restore');
 const policies="select tablename,policyname,permissive,roles::text,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname";
 assert.deepEqual((await restored.query(policies)).rows,(await source.query(policies)).rows);checks.push('RLS policies survive unchanged');
 const acl="select p.oid::regprocedure::text signature,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef order by signature";
 assert.deepEqual((await restored.query(acl)).rows,(await source.query(acl)).rows);checks.push('privileged-function ACLs survive unchanged');
 for(const f of files)assert.deepEqual(await readFile(join(root,'restored-files',...f.path.split('/'))),f.data);checks.push('all original PDF bytes survive unchanged');
 assert.equal((await source.query('select count(*)::int n from fin_companies')).rows[0].n,liveBefore);checks.push('live source and other merchants remain untouched');
 await assert.rejects(restoreDrillDatabase({connection:conn(targetName),data:dump,env}),/DATABASE_NOT_EMPTY/);checks.push('populated restore target is refused');
 await verifyBundle({directory:bundle,passphrase});
 console.log(JSON.stringify({ok:true,engine:'PostgreSQL 17 native TCP',migrations:50,merchants:4,documents:4,originalFiles:4,checks,dumpSha256:createHash('sha256').update(dump).digest('hex'),seconds:Math.round((Date.now()-before)/1000),remoteAccess:false,supabaseManagedSchemas:'minimal local stubs, not full hosted Supabase restoration'}));
}finally{
 await restored?.end().catch(()=>{});await source?.end().catch(()=>{});await admin?.end().catch(()=>{});
 if(started)await control(['-D',data,'-m','fast','-w','stop']).catch(()=>{});
 if(resolve(root).startsWith(resolve(tmpdir())+sep+'nordla-native-recovery-'))await rm(root,{recursive:true,force:true});
}
