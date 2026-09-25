// Integration fixtures must not contact the public release service.
process.env.BOTSPACE_NO_UPDATE_CHECK ??= "1";
// Ordinary fixture setup must never install a real dependency or start a worker.
// Installer tests supply their own isolated PATH and fake uv executable.
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, delimiter } from "node:path";
mkdirSync(".cache", { recursive: true });
const bin = mkdtempSync(resolve(".cache/dependency-fixture-"));
writeFileSync(
  join(bin, "kanbot"),
  `#!${process.execPath}\nif(process.argv[2]!=='--version')process.exit(99);console.log('kanbot 0.9.11');\n`,
  { mode: 0o700 },
);
process.env.PATH = bin + delimiter + process.env.PATH;
process.on("exit", () => rmSync(bin, { recursive: true, force: true }));
