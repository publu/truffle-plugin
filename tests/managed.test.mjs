import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, readdir, symlink, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const execute = promisify(execFile);
const cli = resolve('plugins/truffle-plugin/scripts/truffle.mjs');
const fakeRunner = `#!${process.execPath}
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('kanbot 0.9.6');process.exit(0);}
if(args[0]!=='swarm')process.exit(2);
const home=process.env.KANBOT_HOME;
mkdirSync(home,{recursive:true});
const file=join(home,'fake-state.json');
let state=existsSync(file)?JSON.parse(readFileSync(file)):{running:false,paused:true,starts:0,sends:{}};
const value=flag=>args[args.indexOf(flag)+1];
const command=args[1];
const record={command,args,home,sock:process.env.KANBOT_SOCK||null,db:process.env.KANBOT_DB||null};
if(args.includes('--invite-file')){
 const path=value('--invite-file'),invite=readFileSync(path,'utf8');
 record.inviteHash=createHash('sha256').update(invite).digest('hex');
 record.inviteMode=statSync(path).mode&0o777;
}
appendFileSync(process.env.FAKE_CALLS,JSON.stringify(record)+'\\n');
if(process.env.FAKE_FAIL){console.error(process.env.FAKE_FAIL);process.exit(2);}
let result;
if(command==='connect'){state.workspace=args[2];state.name=value('--name');state.connected=true;result={connected:true,workspace:state.workspace,name:state.name,apiToken:'private-engine-token',nested:{invite:'private-invite',okay:true}};}
else if(command==='start'){state.running=true;state.paused=false;state.starts++;result=state;}
else if(command==='pause'){state.running=false;state.paused=true;result=state;}
else if(command==='status')result=state;
else if(command==='send'){
 const id=value('--request-id');
 state.sends[id]??={id:'job-'+Object.keys(state.sends).length,requestId:id,status:'queued'};
 result=state.sends[id];
}else if(command==='job')result=Object.values(state.sends).find(j=>j.id===args[2])||{id:args[2],status:'missing'};
else if(command==='cancel')result={id:args[2],status:'cancelled'};
else process.exit(3);
writeFileSync(file,JSON.stringify(state));console.log(JSON.stringify(result));
`;
async function fixture(t, {engine=true, runtime=true}={}) {
  await mkdir('.cache',{recursive:true});
  const dir=resolve(await mkdtemp('.cache/managed-cli-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const bin=join(dir,'bin'),store=join(dir,'store'),project=join(dir,'project'),calls=join(dir,'calls.jsonl');
  await mkdir(bin);await mkdir(project);await mkdir(store);
  if(engine)await writeFile(join(bin,'kanbot'),fakeRunner,{mode:0o700});
  if(runtime)await writeFile(join(bin,'codex'),`#!${process.execPath}\nprocess.exit(0);\n`,{mode:0o700});
  const env={...process.env,PATH:bin,FAKE_CALLS:calls,KANBOT_SOCK:join(dir,'unrelated.sock'),KANBOT_DB:join(dir,'unrelated.db')};
  const run=async(args,extra={})=>{
    try {const r=await execute(process.execPath,[cli,'--store',store,'--profile','test',...args],{cwd:project,env:{...env,...extra},timeout:10000});return {...r,code:0,json:r.stdout.trim()?JSON.parse(r.stdout):null};}
    catch(e){if(e.killed)throw e;return {code:e.code,stdout:e.stdout,stderr:e.stderr,json:null};}
  };
  const connect=(args=[],extra={})=>run(['managed','connect','--workspace','demo','--url','https://example.test/w/demo','--runtime','codex','--directory',project,'--allow-from','human-owner',...args],extra);
  const metadata=join(store,'managed','test','demo','connection.json');
  const log=async()=>{try{return (await readFile(calls,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  return {dir,bin,store,project,calls,metadata,run,connect,log};
}
function okay(r){assert.equal(r.code,0,r.stderr);return r.json;}

test('managed CLI preserves paused connection and settings; explicit resume owns one runner',async t=>{
 const f=await fixture(t);
 assert.equal(okay(await f.connect()).service.running,true);
 assert.equal(okay(await f.run(['managed','status','--workspace','demo'])).running,true);
 assert.equal(okay(await f.run(['managed','pause','--workspace','demo'])).paused,true);
 const reconnect=okay(await f.run(['managed','connect','--workspace','demo']));
 assert.equal(reconnect.reused,true);assert.equal(reconnect.running,false);assert.equal(reconnect.paused,true);
 assert.equal((await f.log()).filter(c=>c.command==='connect').length,1);
 assert.equal((await f.log()).filter(c=>c.command==='start').length,1);
 for(const [flag,value] of [['--mode','work'],['--allow-from','human-other'],['--concurrency','4']]){
   const changed=await f.run(['managed','connect','--workspace','demo',flag,value]);
   assert.notEqual(changed.code,0);assert.match(changed.stderr,/preserv|differs/i);
 }
 assert.equal(okay(await f.run(['managed','resume','--workspace','demo'])).running,true);
 const records=await f.log();assert.ok(records.every(c=>c.sock===null&&c.db===null));
 assert.ok(records.every(c=>c.home===join(f.store,'managed','test','demo','runner')));
 assert.equal((await stat(f.metadata)).mode&0o777,0o600);
});

test('managed send requires and preserves stable request IDs across retry',async t=>{
 const f=await fixture(t);okay(await f.connect());
 const task=join(f.project,'task.md');await writeFile(task,'Complete the saved onboarding task.');
 const args=['managed','send','--workspace','demo','--file',task];
 const missing=await f.run(args);assert.notEqual(missing.code,0);assert.match(missing.stderr,/request-id/);
 const first=okay(await f.run([...args,'--request-id','task-123']));
 const second=okay(await f.run([...args,'--request-id','task-123']));
 assert.equal(first.id,second.id);assert.equal(second.requestId,'task-123');
 const sends=(await f.log()).filter(c=>c.command==='send');assert.equal(sends.length,2);
 assert.ok(sends.every(c=>c.args[c.args.indexOf('--request-id')+1]==='task-123'));
 assert.equal(okay(await f.run(['managed','job','--workspace','demo','--id',first.id])).id,first.id);
});

test('invalid managed settings can be corrected without abandoning the alias',async t=>{
 const f=await fixture(t);
 for(const args of [['--max-turns','abc'],['--timeout','-1'],['--runtimes','hermes'],['--instructions',join(f.project,'missing.md')]]){
  const rejected=await f.connect(args);assert.notEqual(rejected.code,0,'invalid configuration accepted: '+args.join(' '));
 }
 assert.equal((await f.log()).filter(c=>c.command==='connect').length,0);
 assert.equal(okay(await f.connect(['--max-turns','5','--no-start'])).service.paused,true);
});

test('incomplete connection retries preserve identity without resuming a paused team',async t=>{
 const f=await fixture(t);
 const failed=await f.connect(['--no-start'],{FAKE_FAIL:'Temporary network failure'});assert.notEqual(failed.code,0);
 const retry=okay(await f.run(['managed','connect','--workspace','demo','--no-start']));
 assert.equal(retry.service.paused,true);
 const config=JSON.parse(await readFile(f.metadata,'utf8'));assert.equal(config.name,'truffle-team');assert.equal(config.configured,true);
 assert.equal((await f.log()).filter(c=>c.command==='start').length,0);
});

test('invitation reaches engine through a private temporary file and is removed from output and metadata',async t=>{
 const f=await fixture(t),secret='invitation-0123456789abcdef0123456789abcdef';
 const link=join(f.dir,'invite-link');await writeFile(link,'https://example.test/w/demo#invite='+secret,{mode:0o600});
 const r=await f.run(['managed','connect','--workspace','demo','--link-file',link,'--runtime','codex','--directory',f.project,'--allow-from','human-owner','--no-start']);okay(r);
 const metadata=await readFile(f.metadata,'utf8');
 assert.ok(!r.stdout.includes(secret));assert.ok(!r.stderr.includes(secret));assert.ok(!metadata.includes(secret));
 assert.ok(!r.stdout.includes('private-engine-token'));assert.ok(!r.stdout.includes('private-invite'));
 const connect=(await f.log()).find(c=>c.command==='connect');
 assert.equal(connect.inviteHash,createHash('sha256').update(secret).digest('hex'));assert.equal(connect.inviteMode,0o600);
 assert.ok(!connect.args.some(a=>a.includes(secret)));
 assert.ok(!(await readdir(join(f.store,'managed','test','demo'))).some(n=>n.startsWith('.invite-')));
});

test('managed commands reject a copied connection that points to another runner home',async t=>{
 const f=await fixture(t);okay(await f.connect(['--no-start']));
 const saved=JSON.parse(await readFile(f.metadata,'utf8'));saved.home=join(f.dir,'other-team');await writeFile(f.metadata,JSON.stringify(saved));
 const before=(await f.log()).length;
 const r=await f.run(['managed','resume','--workspace','demo']);assert.notEqual(r.code,0);assert.match(r.stderr,/home|ownership|outside|path/i);
 assert.equal((await f.log()).length,before);
});

test('managed setup refuses a symlinked destination',async t=>{
 const f=await fixture(t),outside=join(f.dir,'other-store');await mkdir(outside);await symlink(outside,join(f.store,'managed'));
 const r=await f.connect();assert.notEqual(r.code,0);assert.match(r.stderr,/symlink/i);
 assert.deepEqual(await readdir(outside),[]);
});

test('onboard recognizes a managed-only saved team',async t=>{
 const f=await fixture(t);okay(await f.connect(['--no-start']));
 const r=okay(await f.run(['onboard']));assert.equal(r.workspaces.length,0);assert.equal(r.managed.length,1);
 assert.doesNotMatch(r.next,/ask which workspace/i);assert.match(r.next,/saved|paused|reuse|resume/i);
});

test('managed setup explains missing engine, missing runtime and connects an installed Hermes runner',async t=>{
 const noEngine=await fixture(t,{engine:false});const e=await noEngine.connect();assert.notEqual(e.code,0);assert.match(e.stderr,/managed install/);
 const noRuntime=await fixture(t,{runtime:false});const r=await noRuntime.connect();assert.notEqual(r.code,0);assert.match(r.stderr,/codex.*not installed/i);
 const f=await fixture(t);await writeFile(join(f.bin,'hermes'),`#!${process.execPath}\nprocess.exit(0);\n`,{mode:0o700});const h=await f.run(['managed','connect','--workspace','demo','--url','https://example.test/w/demo','--runtime','hermes','--directory',f.project,'--allow-from','human-owner']);
 assert.equal(okay(h).service.running,true);
 const calls=await f.log();assert.ok(calls.some(c=>c.command==='connect'&&c.args.includes('hermes')));
 assert.ok(calls.some(c=>c.command==='start'));
});

test('managed installation confines uv tools and executables to the private store',async t=>{
 const f=await fixture(t,{engine:false});
 await writeFile(join(f.bin,'uv'),`#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.FAKE_CALLS,JSON.stringify({args:process.argv.slice(2),tools:process.env.UV_TOOL_DIR,bin:process.env.UV_TOOL_BIN_DIR}));
`,{mode:0o700});
 const result=okay(await f.run(['managed','install']));assert.equal(result.installed,true);assert.equal(result.scope,'private Truffle store');
 const call=JSON.parse(await readFile(f.calls,'utf8'));
 assert.deepEqual(call.args,['tool','install','--force','kanbot==0.9.6']);
 assert.equal(call.tools,join(f.store,'engines','tools'));assert.equal(call.bin,join(f.store,'engines','bin'));
});

test('managed subprocess errors redact invitation URLs and bearer credentials',async t=>{
 const f=await fixture(t);
 const invite='short-private-invite',bearer='short-private-bearer';
 const r=await f.connect([],{FAKE_FAIL:'Rejected https://example.test/w/demo#invite='+invite+' Authorization: Bearer '+bearer});
 assert.notEqual(r.code,0);assert.ok(!r.stderr.includes(invite));assert.ok(!r.stderr.includes(bearer));assert.match(r.stderr,/redacted/);
});
