import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { planContactImport, sendContactBatch } from "../scripts/contact-import.mjs";
const exec = promisify(execFile);
test("ambiguous import flags fail before loading credentials or sending a write", async () => {
  for (const flags of [["--apply", "false"], ["--apply", "--dry-run", "true"]]) {
    await assert.rejects(exec(process.execPath, ["plugins/truffle-plugin/scripts/client.mjs", "entity-import", "--file", "does-not-exist.json", ...flags]), error => /--apply takes no value/.test(error.stderr));
  }
});
test("empty imports fail locally without an API request", async () => {
  assert.throws(() => planContactImport({ importId: "empty-import", records: [] }));
  let calls = 0;
  await assert.rejects(sendContactBatch(async () => { calls++; }, { importId: "empty-import", records: [] }));
  assert.equal(calls, 0);
});
