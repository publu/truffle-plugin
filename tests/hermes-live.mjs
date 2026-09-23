// Opt-in real Hermes verification: isolated project tools and native session reuse.
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runRuntime} from '../plugins/truffle-plugin/scripts/runtimes.mjs';

await mkdir('.cache', {recursive:true});
const root = resolve(await mkdtemp('.cache/hermes-live-'));
const directory = join(root, 'project'), stateDirectory = join(root, 'state');
await mkdir(directory);
await writeFile(join(directory, 'numbers.json'), '[17,25]\n');
const marker = 'swarm-' + randomUUID();
let passed = false;
try {
  const first = await runRuntime({runtime:'hermes', mode:'work', directory, stateDirectory,
    signal:AbortSignal.timeout(180000), prompt:`This is an authorized isolated project test. Read numbers.json with your project file tool. Compute the sum and write only that number to answer.txt. Use project_run to run a Python command that reads answer.txt, asserts its stripped value is 42, and writes command-proof.txt with the text verified. Do not touch anything outside this project. Remember this session marker: ${marker}. Return a short confirmation when the actual file and command steps succeeded.`});
  assert.ok(first.session);
  assert.equal((await readFile(join(directory,'answer.txt'),'utf8')).trim(),'42');
  assert.equal((await readFile(join(directory,'command-proof.txt'),'utf8')).trim(),'verified');
  const resumed = await runRuntime({runtime:'hermes', mode:'read', directory, stateDirectory, session:first.session,
    signal:AbortSignal.timeout(180000), prompt:'Continue the earlier test. Read answer.txt using your project tool, then return the answer and the exact session marker I asked you to remember. You now have read-only project access. Do not modify any file.'});
  assert.equal(resumed.session,first.session);
  assert.ok(resumed.text.includes(marker), 'native session must retain the earlier marker');
  assert.match(resumed.text,/42/);
  assert.equal((await readFile(join(directory,'answer.txt'),'utf8')).trim(),'42');
  console.log(JSON.stringify({passed:true,runtime:'hermes',turns:2,verified:['real model','project file read','project file write','project command','native session continuation','read-only resumed session']},null,2));
  passed = true;
} finally {
  if (passed) await rm(root,{recursive:true,force:true});
  else console.error('Private failure diagnostics retained at ' + root);
}
