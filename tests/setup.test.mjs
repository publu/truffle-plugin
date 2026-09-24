import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setup } from '../plugins/truffle-plugin/scripts/setup.mjs';
test('TUI setup installs self-contained instructions, preserves existing files and safely updates managed skills',async()=>{
 await mkdir('.cache',{recursive:true});
 const base=resolve(await mkdtemp('.cache/setup-'));
 await mkdir(join(base,'.botspace'));
 await writeFile(join(base,'.botspace','keep.json'),'private-outbox');
 for(const target of ['codex','claude']) {
  await setup({target,directory:base});
  const file=join(base,target==='codex'?'.agents':'.claude','skills','botspace','SKILL.md');
  const text=await readFile(file,'utf8');
  assert.match(text,/name: botspace/);assert.match(text,/botspace inbox/);
  assert.ok(!text.includes('BOTSPACE_CLI'));assert.ok(!text.includes('../../scripts'));
  assert.equal((await setup({target,directory:base})).updated,true);
 }
 assert.equal(await readFile(join(base,'.botspace','keep.json'),'utf8'),'private-outbox');
 const skill=join(base,'.agents','skills','botspace','SKILL.md');
 await writeFile(skill,'My own skill');
 await assert.rejects(setup({target:'codex',directory:base}),/unmanaged/);
 assert.equal(await readFile(skill,'utf8'),'My own skill');
 await assert.rejects(setup({target:'unknown',directory:base}),/Use --target/);
 const linked=resolve(await mkdtemp('.cache/linked-'));
 await symlink(join(base,'.agents'),join(linked,'.agents'));
 await assert.rejects(setup({target:'codex',directory:linked}),/symlink/);
});

test('Kimi setup uses the same skill and stable bundled client, without an npm requirement',async()=>{
 await mkdir('.cache',{recursive:true});const base=resolve(await mkdtemp('.cache/kimi-setup-'));
 await setup({target:'kimi',directory:base});
 const content=await readFile(join(base,'.agents','skills','botspace','SKILL.md'),'utf8');
 assert.match(content,/First-run conversation/);assert.match(content,/scripts\/botspace.mjs/);
 assert.ok(!content.includes('BOTSPACE_CLI'));assert.ok(!content.includes('npm install'));assert.ok(content.includes('Safe update workflow'));assert.ok(content.includes('Defer while affected workers'));assert.ok(content.includes('references/wiki-workflow.md'));
 assert.match(content,/activate/);assert.equal((await setup({target:'kimi',directory:base})).updated,true);
});
