#!/usr/bin/env node
// Explicit opt-in: existing operator membership, real records, dry-run requests only.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { planContactImport, sendContactBatch } from "./contact-import.mjs";
const args = process.argv.slice(2);
const need = name => {
  const at = args.indexOf("--" + name);
  if (at < 0 || !args[at + 1]) throw Error(`Provide --${name}`);
  return args[at + 1];
};
const configPath = resolve(need("config")), store = resolve(need("store")),
  profile = need("profile"), workspace = need("workspace"),
  plugin = resolve(need("plugin"));
const cfg = JSON.parse(await readFile(configPath, "utf8"));
const exec = promisify(execFile);
async function get(path) {
  const response = await fetch(cfg.api + path, { headers: { Authorization: "Bearer " + cfg.token }, redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  return response.json();
}
const pages = await Promise.all([get("/network?view=contacts"), get("/network?view=contacts&page=1")]);
const before = pages.flatMap(p => p.entities).slice(0, 61);
assert.equal(before.length, 61, "This check needs 61 existing authorized contacts");
const records = before.map(({ id, version }) => ({ id, version }));
const input = { importId: "plugin-verification-" + Date.now(), records };
const dry = planContactImport(input), apply = planContactImport(input, true);
assert.deepEqual(dry.batches.map(({ importId, records }) => ({ importId, records })), apply.batches.map(({ importId, records }) => ({ importId, records })));
assert.deepEqual(dry.batches.map(b => b.records.length), [50, 11]);
assert.throws(() => planContactImport({ ...input, records: [records[0], records[0]] }), /Duplicate/);
assert.throws(() => planContactImport({ ...input, records: [{ ...records[0], unknown: true }] }));
// Check receipt handling with the same real ids; no network writes occur here.
await sendContactBatch(async b => ({ importId: b.importId, records: b.records.map(r => ({ id: r.id, version: r.version + 1 })), replayed: true }), apply.batches[0]);
await assert.rejects(sendContactBatch(async b => ({ importId: b.importId, records: [] }), dry.batches[0]), /incomplete/);
await mkdir(".local", { recursive: true });
const dir = await mkdtemp(resolve(".local/plugin-import-check-"));
const file = dir + "/import.json";
await writeFile(file, JSON.stringify(input), { mode: 0o600 });
const { stdout } = await exec(process.execPath, [plugin + "/scripts/truffle.mjs", "entity-import", "--file", file, "--store", store, "--profile", profile, "--workspace", workspace], { maxBuffer: 2e6 });
const result = JSON.parse(stdout);
assert.equal(result.dryRun, true);
assert.equal(result.completed, 61);
assert.deepEqual(result.batches.map(b => b.records.length), [50, 11]);
assert.ok(result.agentNotice);
assert.equal(JSON.parse(await readFile(file + ".dry-run-receipt.json", "utf8")).completed, 61);
const transport = new StdioClientTransport({ command: process.execPath, args: [plugin + "/scripts/swarm-mcp.mjs", "--config", configPath], env: { ...process.env } });
const client = new Client({ name: "operator-import-readonly-check", version: "1" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const tool = tools.find(t => t.name === "botspace_contacts_import");
  assert.ok(tool);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.equal(tool.annotations.idempotentHint, true);
  const checked = await client.callTool({ name: tool.name, arguments: { importId: input.importId + "-mcp", records: records.slice(0, 2) } });
  assert.ok(!checked.isError);
  assert.equal(checked.structuredContent.dryRun, true);
  assert.equal(checked.structuredContent.records.length, 2);
  const conflict = await client.callTool({ name: tool.name, arguments: { importId: input.importId + "-stale", dryRun: true, records: [{ ...records[0], version: records[0].version + 10 }] } });
  assert.equal(conflict.isError, true);
  assert.equal(conflict.structuredContent.status, 409);
  assert.match(conflict.structuredContent.error, /reconcile/);
} finally { await client.close(); }
const after = (await Promise.all([get("/network?view=contacts"), get("/network?view=contacts&page=1")])).flatMap(p => p.entities).slice(0, 61);
assert.deepEqual(after, before);
console.log(JSON.stringify({ cli: "61 real contacts validated in 50+11 batches", mcp: "tool discovery, default dry-run and 409 handling passed", sourcePlanning: "stable ids and duplicate/unknown-field rejection passed", receipts: "saved", contactMutations: 0 }));
