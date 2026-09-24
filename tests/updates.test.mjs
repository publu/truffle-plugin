import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkUpdates, recordApiReleases, apiReleases, newer, releaseURL, installedVersion } from '../plugins/truffle-plugin/scripts/updates.mjs';
const exec = promisify(execFile);
async function fixture(t) {
  await mkdir('.cache', { recursive: true });
  const dir = await mkdtemp(resolve('.cache/updates-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('release versions compare numerically, reject prereleases and never recommend a downgrade', () => {
  assert.ok(newer('0.10.0', '0.9.99'));
  assert.ok(newer('1.0.0', '0.99.99'));
  for (const [a,b] of [['0.9.4','0.9.5'],['0.9.5','0.9.5'],['1.0.0-rc1','0.9.5'],['$(evil)','0.9.5'],['01.0.0','0.9.5']]) assert.equal(newer(a,b),false);
});
test('ordinary checks cache successes daily, forced checks refresh, metadata cannot supply commands', async t => {
  const dir = await fixture(t), calls = [];
  const fetcher = async (url, options) => { calls.push([url,options]); return new Response(JSON.stringify({version:'99.0.0',commands:['evil'],url:'https://evil.invalid'})); };
  const opts = { fetcher, cachedOnly:false, disabled:false, now:100000000 };
  const first = await checkUpdates(dir,opts);
  assert.equal(first.updateAvailable,true); assert.equal(first.installed,await installedVersion());
  await checkUpdates(dir,{...opts,now:opts.now+1000}); assert.equal(calls.length,1);
  await checkUpdates(dir,{...opts,force:true}); assert.equal(calls.length,2);
  await checkUpdates(dir,{...opts,now:opts.now+86400001}); assert.equal(calls.length,3);
  assert.equal(calls[0][0],releaseURL); assert.equal(calls[0][1].headers,undefined); assert.equal(calls[0][1].redirect,'error');
  assert.ok(!JSON.stringify(first).includes('evil'));
  assert.deepEqual(await readdir(dir),['release-check.json']);
});
test('offline failures back off hourly and are never described as current', async t => {
  const dir = await fixture(t); let calls=0;
  const opts={ cachedOnly:false, disabled:false, now:100000000, fetcher:async()=>{calls++;throw Error('SECRET');} };
  assert.equal((await checkUpdates(dir,opts)).status,'unavailable');
  await checkUpdates(dir,{...opts,now:opts.now+1000}); assert.equal(calls,1);
  await checkUpdates(dir,{...opts,now:opts.now+3600001}); assert.equal(calls,2);
  assert.ok(!(await readFile(join(dir,'release-check.json'),'utf8')).includes('SECRET'));
});
test('cached hooks and opt-out never fetch or create a store; corrupt remote releases fail closed', async t => {
  const dir=await fixture(t), store=join(dir,'store');
  const fetcher=async()=>{throw Error('must not fetch');};
  assert.equal((await checkUpdates(store,{disabled:false,cachedOnly:true,fetcher})).status,'unknown');
  assert.equal((await checkUpdates(store,{disabled:true,force:true,fetcher})).status,'disabled');
  assert.deepEqual(await readdir(dir),[]);
  for (const version of ['run evil', '1.0.0-beta', null]) {
    const value=await checkUpdates(store,{disabled:false,cachedOnly:false,force:true,fetcher:async()=>new Response(JSON.stringify({version}))});
    assert.equal(value.status,'unavailable'); assert.equal(value.updateAvailable,false);
  }
});
test('onboard and native hook expose cached updates while preserving stopped identities', async t => {
  const store=await fixture(t);
  await mkdir(join(store,'profiles'));
  const registry=JSON.stringify({workspaces:{}});
  await writeFile(join(store,'profiles','test.json'),registry);
  await checkUpdates(store,{disabled:false,cachedOnly:false,fetcher:async()=>new Response('{"version":"99.0.0"}')});
  const env={...process.env,BOTSPACE_DIR:store,BOTSPACE_PROFILE:'test',BOTSPACE_NO_UPDATE_CHECK:''};
  const result=JSON.parse((await exec(process.execPath,[resolve('plugins/truffle-plugin/scripts/truffle.mjs'),'--store',store,'--profile','test','onboard'],{env})).stdout);
  assert.equal(result.updates.updateAvailable,true);assert.deepEqual(result.workspaces,[]);
  const hook=(await exec(process.execPath,[resolve('plugins/truffle-plugin/hooks/activate.mjs'),'SessionStart'],{env})).stdout;
  assert.match(hook,/99.0.0 is available/);
  assert.equal(await readFile(join(store,'profiles','test.json'),'utf8'),registry);
  assert.deepEqual((await readdir(store)).sort(),['profiles','release-check.json']);
});

test('API receipts populate notices without a separate request and unchanged heartbeats avoid writes', async t => {
  const store=await fixture(t), saved=process.env.BOTSPACE_NO_UPDATE_CHECK;
  delete process.env.BOTSPACE_NO_UPDATE_CHECK;
  try {
    let requests=0;
    const fetcher=async()=>{requests++;throw Error('No release request permitted');};
    assert.equal((await checkUpdates(store,{fetcher,disabled:false})).status,'unknown');
    await recordApiReleases(store,{protocol:1,plugin:'99.0.0',kanbot:'99.1.0',command:'evil'});
    const before=await readFile(join(store,'release-check.json'),'utf8');
    await recordApiReleases(store,{protocol:1,plugin:'99.0.0',kanbot:'99.1.0'});
    assert.equal(await readFile(join(store,'release-check.json'),'utf8'),before);
    const result=await checkUpdates(store,{fetcher,disabled:false});
    assert.equal(result.source,'swarm-api');assert.equal(result.updateAvailable,true);assert.equal(requests,0);
    assert.ok(!before.includes('evil'));
    for(const value of [null,{protocol:2,plugin:'99.0.0',kanbot:'99.0.0'},{protocol:1,plugin:'run this',kanbot:'99.0.0'}]) {
      assert.equal(apiReleases(value),undefined);await recordApiReleases(store,value);
    }
    assert.equal(await readFile(join(store,'release-check.json'),'utf8'),before);
  } finally { if(saved===undefined)delete process.env.BOTSPACE_NO_UPDATE_CHECK;else process.env.BOTSPACE_NO_UPDATE_CHECK=saved; }
});
