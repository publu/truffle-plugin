import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = resolve("plugins/truffle-plugin");
const hooks = JSON.parse(await readFile(join(root, "hooks/hooks.json"), "utf8")).hooks;
async function run(cwd, event = "SessionStart", extraEnv = {}) {
  const env = { ...process.env, CLAUDE_PLUGIN_ROOT: root };
  for (const key of ["BOTSPACE_DIR", "BOTSPACE_PROFILE", "BOTSPACE_CONNECTOR"]) delete env[key];
  Object.assign(env, extraEnv);
  const { stdout, stderr } = await exec("/bin/sh", ["-c", hooks[event][0].hooks[0].command], {
    cwd, env, timeout: 3000,
  });
  assert.equal(stderr, "");
  const output = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, event);
  return output.additionalContext;
}

test("native activation works before setup and carries collaboration into subagents", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = await run(dir);
  assert.match(first, /No usable connection/);
  assert.match(first, /Maintain the project wiki as part of normal Truffle work/);
  assert.match(first, /read-only mode or without sharing authorization/);
  assert.match(first, /Do not require the user to name the plugin/);
  assert.ok(first.includes(join(root, "skills/collaborate/SKILL.md")));
  assert.deepEqual(await readdir(dir), []); // Startup doesn't create setup or processes.
  assert.match(await run(dir, "SubagentStart"), /Leave onboarding, connection activation, and pause\/resume to the parent/);
  for (const event of Object.keys(hooks)) {
    const worker = await run(dir, event, { BOTSPACE_CONNECTOR: "1" });
    assert.match(worker, /Do not onboard, start listeners, or call send\/reply\/ack/);
    assert.match(worker, /Maintain the project wiki/);
    assert.doesNotMatch(worker, /No usable connection/);
  }
});

test("activation reuses profiles, preserves pause, excludes credentials, and tolerates damaged setup", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, ".botspace");
  await mkdir(join(store, "profiles"), { recursive: true });
  const config = join(store, "identity.json");
  await writeFile(config, JSON.stringify({ token: "SECRET_TOKEN" }));
  await writeFile(config + ".listener.stop", "stop\n");
  const registry = JSON.stringify({ workspaces: { team: {
    name: "reviewer", config, workspace: "https://example.com/w/team#invite=SECRET_INVITE",
    automation: { args: ["--runtime", "claude", "--allow-from", "SECRET_SENDER"] },
  } } });
  await writeFile(join(store, "profiles/reviewer.json"), registry);
  await writeFile(join(store, "profiles/broken.json"), "{");
  const snapshot = await run(dir);
  assert.match(snapshot, /"profile":"reviewer"/);
  assert.match(snapshot, /"paused":true/);
  assert.match(snapshot, /"runtime":"claude"/);
  assert.match(snapshot, /could not be read; do not replace/);
  assert.doesNotMatch(snapshot, /SECRET_/);
  assert.equal(await readFile(config + ".listener.stop", "utf8"), "stop\n");
  assert.equal(await readFile(join(store, "profiles/reviewer.json"), "utf8"), registry);
  const custom = await run(dir, "SessionStart", { BOTSPACE_DIR: store, BOTSPACE_PROFILE: "reviewer" });
  assert.match(custom, /"profile":"reviewer"/);
  assert.doesNotMatch(custom, /Profile "broken"/);
  await rm(config + ".listener.stop");
  assert.match(await run(dir), /"paused":false/);
});

test("activation discovers managed-only teams without exposing runner state or starting work", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-managed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = join(dir, ".botspace");
  const team = join(store, "managed", "owner", "project");
  await mkdir(team, { recursive: true });
  const metadata = JSON.stringify({
    alias: "ignored-stored-alias", name: "project-team", runtime: "codex", configured: true,
    home: "/SECRET_HOME", directory: "/SECRET_PROJECT", token: "SECRET_TOKEN",
    workspace: "https://example.test/w/project#invite=SECRET_INVITE", allowFrom: "SECRET_SENDER",
    running: true, paused: false, settings: { instructions: "SECRET_INSTRUCTIONS" },
  });
  await writeFile(join(team, "connection.json"), metadata);
  await mkdir(join(store, "managed", "other", "unrelated"), { recursive: true });
  await writeFile(join(store, "managed", "other", "unrelated", "connection.json"), JSON.stringify({name:"other-team",runtime:"claude",configured:true}));
  const before = (await readdir(store, { recursive: true })).sort();
  const snapshot = await run(dir, "SessionStart", { BOTSPACE_PROFILE: "owner" });
  assert.doesNotMatch(snapshot, /No usable connection|could not be read|SECRET_|other-team|ignored-stored-alias/);
  const line = snapshot.split("\n").find(line => line.startsWith("Saved managed connection metadata"));
  const summary = JSON.parse(line.slice(line.indexOf(": ") + 2));
  assert.deepEqual(summary, {profile:"owner",managed:[{alias:"project",name:"project-team",runtime:"codex",configured:true,engine:"kanbot"}]});
  assert.doesNotMatch(JSON.stringify(summary), /running|paused|home|directory|allowFrom|instructions|workspace/);
  assert.match(snapshot, /Use onboard.*check current status/);
  assert.equal(await readFile(join(team, "connection.json"), "utf8"), metadata);
  assert.deepEqual((await readdir(store, { recursive: true })).sort(), before);
  const all = await run(dir);
  assert.match(all, /project-team/);assert.match(all, /other-team/);
  const wrongProfile = await run(dir, "SessionStart", {BOTSPACE_PROFILE:"missing"});
  assert.match(wrongProfile, /No usable connection/);assert.doesNotMatch(wrongProfile, /project-team|other-team/);
});

test("managed activation bounds metadata reads and tolerates damaged records", async (t) => {
  await mkdir(".cache", { recursive: true });
  const dir = await mkdtemp(resolve(".cache/hooks-managed-bounds-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const profile = join(dir, ".botspace", "managed", "owner");
  for (const [alias, content] of [["valid",JSON.stringify({name:"valid-team",runtime:"kimi",configured:false})],["broken","{"],["large",JSON.stringify({name:"OVERSIZED",extra:"x".repeat(66000)})]]) {
    await mkdir(join(profile,alias),{recursive:true});await writeFile(join(profile,alias,"connection.json"),content);
  }
  const snapshot = await run(dir);
  assert.match(snapshot, /valid-team/);assert.match(snapshot, /"configured":false/);
  assert.doesNotMatch(snapshot, /OVERSIZED|No usable connection/);
});
