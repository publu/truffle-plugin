import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setup } from '../plugins/truffle-plugin/scripts/setup.mjs';
import { runtimeCommand } from '../plugins/truffle-plugin/scripts/runtimes.mjs';

test('Hermes installs a self-contained portable skill into the selected profile and preserves user settings', async () => {
  await mkdir('.cache', { recursive: true });
  const profile = resolve(await mkdtemp('.cache/hermes-setup-'));
  const previous = process.env.HERMES_HOME;
  process.env.HERMES_HOME = profile;
  try {
    await writeFile(join(profile, 'config.yaml'), 'model: existing-model\n');
    await writeFile(join(profile, '.env'), 'KEEP=private\n');
    const result = await setup({ target: 'hermes', global: true });
    assert.equal(result.path, join(profile, 'skills', 'botspace', 'SKILL.md'));
    const content = await readFile(result.path, 'utf8');
    assert.match(content, /name: botspace/);
    assert.match(content, /scripts\/botspace.mjs/);
    assert.match(content, /Background Hermes turns are not supported/);
    assert.match(content, /Do not run activate, listen, resume, inbox --wait/);
    assert.match(content, /## Shared project data/);
    assert.doesNotMatch(content, /## Automatic runtime connector|## Wait without polling|BOTSPACE_CLI|npm install/);
    assert.equal((await setup({ target: 'hermes', global: true })).updated, true);
    assert.equal(await readFile(join(profile, 'config.yaml'), 'utf8'), 'model: existing-model\n');
    assert.equal(await readFile(join(profile, '.env'), 'utf8'), 'KEEP=private\n');
    await writeFile(result.path, 'An independently installed skill');
    await assert.rejects(setup({ target: 'hermes', global: true }), /unmanaged/);
    assert.equal(await readFile(result.path, 'utf8'), 'An independently installed skill');
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous;
    await rm(profile, { recursive: true, force: true });
  }
});

test('Hermes rejects an undiscoverable project skill and symlinked profile', async () => {
  await assert.rejects(setup({ target: 'hermes', directory: process.cwd() }), /--global/);
  await mkdir('.cache', { recursive: true });
  const dir = resolve(await mkdtemp('.cache/hermes-linked-'));
  const previous = process.env.HERMES_HOME;
  try {
    await mkdir(join(dir, 'actual'));
    await symlink(join(dir, 'actual'), join(dir, 'profile'));
    process.env.HERMES_HOME = join(dir, 'profile');
    await assert.rejects(setup({ target: 'hermes', global: true }), /symlinked Hermes/);
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Hermes background execution fails before spawn with a usable alternative', () => {
  for (const mode of ['read', 'work'])
    assert.throws(() => runtimeCommand('hermes', { mode }), /existing conversation.*--target hermes --global.*read-only execution boundary/);
  assert.equal(runtimeCommand('codex')[0], 'codex');
  assert.equal(runtimeCommand('claude')[0], 'claude');
  assert.deepEqual(runtimeCommand('kimi'), ['kimi', ['acp']]);
});
