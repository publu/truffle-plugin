import { readFile, writeFile, mkdir, lstat, rename } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const marker = "<!-- Managed by botspace setup. -->";
export async function setup({ target, directory, global = false }) {
  if (!["codex", "claude", "kimi", "hermes"].includes(target))
    throw Error(
      "Use --target codex, --target claude, --target kimi, or --target hermes. Other shell-capable agents can use the botspace command directly.",
    );
  if (global && directory)
    throw Error("Choose --global or --directory, not both.");
  if (target === "hermes" && !global)
    throw Error("Hermes loads skills from its profile. Run setup --target hermes --global (set HERMES_HOME to select a different Hermes profile).");
  const base = resolve(
    target === "hermes"
      ? process.env.HERMES_HOME || join(homedir(), ".hermes")
      : global ? homedir() : directory || process.cwd(),
  );
  const parts = [
    ...(target === "hermes" ? [] : [target === "claude" ? ".claude" : ".agents"]),
    "skills",
    "botspace",
  ];
  let current = base;
  if (target === "hermes") {
    try {
      if ((await lstat(base)).isSymbolicLink())
        throw Error("Refusing to modify a symlinked Hermes profile.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  // Do not overwrite another integration through a symlinked skill directory.
  for (const part of parts) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error("Refusing to modify a symlinked skill directory.");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const destination = join(current, "SKILL.md");
  let existing;
  try {
    if ((await lstat(destination)).isSymbolicLink())
      throw Error("Refusing to overwrite a symlinked skill.");
    existing = await readFile(destination, "utf8");
    if (!existing.includes(marker))
      throw Error(
        "An unmanaged Truffle skill already exists; it has been left untouched.",
      );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const source = await readFile(
    new URL("../skills/collaborate/SKILL.md", import.meta.url),
    "utf8",
  );
  // All instructions come from the same reviewed collaboration skill.
  let content = source
    .replace("name: collaborate", "name: botspace")
    .replace(
      /The bundled client is[^\n]+/,
      "The Truffle CLI is installed with npm. Run `botspace help` to check availability. Node.js 22.13+ is required.",
    )
    .replaceAll('node "$BOTSPACE_CLI"', "botspace");
  if (target === "kimi" || target === "hermes") {
    const cli = fileURLToPath(new URL("./botspace.mjs", import.meta.url));
    // The checkout is the installation, not a temporary download; updates keep this path stable.
    const quoted = "'" + cli.replaceAll("'", "'\"'\"'") + "'";
    content = source
      .replace("name: collaborate", "name: botspace")
      .replace(
        /The bundled client is[^\n]+/,
        "The bundled client is available in the stable GitHub checkout. Use the absolute command below; Node.js 22.13+ is required.",
      )
      .replaceAll('node "$BOTSPACE_CLI"', "node " + quoted)
      .replaceAll("BOTSPACE_CLI", "the bundled client");
  }
  content = content.replace(/\n## Install and update\n[\s\S]*?(?=\n## |$)/, "");
  if (target === "hermes") {
    // Hermes discovers portable skills but cannot enforce our read-only runner
    // contract. Keep onboarding inside its existing, user-controlled session.
    for (const heading of ["Automatic activation", "Keep the interactive TUI available", "First-run conversation: own the setup", "Wait without polling", "Automatic runtime connector"])
      content = content.replace(new RegExp("\\n## " + heading + "\\n[\\s\\S]*?(?=\\n## |$)"), "");
    content = content.replace(
      /1\. \*\*Truffle plugin:\*\*[^\n]+/,
      "1. **Truffle plugin:** connects this existing Hermes conversation to a swarm through the bundled client. Hermes keeps its tools, model account, and current session permissions. Background Hermes turns are not supported.",
    );
    content = content.replace("## Connect once", `## First-run conversation: own the setup

Run onboard with the saved store and profile to inspect the existing connection. Reuse the workspace URL, project, goal, and identity from the user's request. Ask only for a missing workspace. Run connect when needed, then use context, inbox, tasks, and pages to do the authorized work in this conversation. The examples below use the stable bundled client.

Do not run activate, listen, resume, inbox --wait, or a polling loop for Hermes. Do not claim to be listening or to have started background agents. Finish with the actual connection result and explain that new work is handled when this conversation runs. For managed background work, the user can explicitly choose an installed Codex, Claude, or Kimi runner with its own identity and permissions; never substitute a runtime silently.

## Connect once`);
  }
  if (target === "kimi" || target === "hermes")
    content +=
      "\n## Install and update\n\nSource: https://github.com/publu/truffle-plugin. Update the stable checkout with git pull --ff-only, rerun this setup command, then " +
      (target === "hermes"
        ? "run /reload-skills in Hermes."
        : "pause and resume configured workspaces using the updated client.") +
      " Keep workspace credentials and saved settings.\n\n" +
      marker +
      "\n";
  else
    content +=
      "\n## Install and update\n\nSource: https://github.com/publu/truffle-plugin. Update with `npm install -g https://github.com/publu/truffle-plugin/releases/latest/download/botspace.tgz`, then rerun the same `botspace setup` command. Workspace credentials and pending sends remain in the private store.\n\n" +
      marker +
      "\n";
  await mkdir(current, { recursive: true });
  const temp = destination + "." + randomUUID() + ".tmp";
  await writeFile(temp, content, { flag: "wx" });
  await rename(temp, destination);
  return {
    target,
    scope: global ? "global" : "project",
    installed: true,
    path: destination,
    updated: !!existing,
    next: target === "hermes"
      ? "Run /reload-skills in Hermes, then ask it to use Truffle with your workspace URL. This connects your existing Hermes conversation; managed background agents currently require Codex, Claude, or Kimi. Credentials and other agent settings were preserved."
      : "Start a new agent session and ask it to use Truffle with your workspace URL. Credentials and other agent settings were preserved.",
  };
}
