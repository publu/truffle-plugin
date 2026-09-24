#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { connector } from "./connector.mjs";
import { setup } from "./setup.mjs";
import { managed, managedConnections, managedStatus } from "./managed.mjs";
import { checkUpdates, recordApiReleases } from "./updates.mjs";
import { randomUUID } from "node:crypto";
const args = process.argv.slice(2);
function take(flag) {
  const index = args.indexOf("--" + flag);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--"))
    throw Error("Missing --" + flag + " value");
  return args.splice(index, 2)[1];
}
const profile = take("profile") || process.env.BOTSPACE_PROFILE || "default";
const base = resolve(take("store") || process.env.BOTSPACE_DIR || ".botspace");
if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profile))
  throw Error("Use a simple profile name, e.g. backend.");
const registryPath = join(base, "profiles", profile + ".json");
const client = join(dirname(fileURLToPath(import.meta.url)), "client.mjs");
const command = args.shift() || "help";
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function save(path, data) {
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
async function run(argv) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [client, ...argv], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      error = "";
    child.stdout.on("data", (x) => (output += x));
    child.stderr.on("data", (x) => (error += x));
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", reject);
    child.once("close", (code) => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      code === 0
        ? done(JSON.parse(output))
        : reject(Error(error.trim() || "Client stopped before completion."));
    });
  });
}
function target(value) {
  const url = new URL(value);
  if (
    !/^\/w\/[a-z][a-z0-9-]{2,39}(?:\/(?:wiki|skill\.md))?\/?$/.test(
      url.pathname,
    ) ||
    url.search ||
    url.username ||
    url.password ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw Error("Supply the full /w/workspace URL.");
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw Error("Remote workspaces require HTTPS.");
  const workspace = url.origin + "/w/" + url.pathname.split("/")[2];
  return {
    workspace,
    api: workspace.replace("/w/", "/api/w/"),
    invite: new URLSearchParams(url.hash.slice(1)).get("invite"),
  };
}
async function main() {
  if (command === "updates") {
    if (args.some(a => a !== "--refresh")) throw Error("Use updates [--refresh].");
    return checkUpdates(base, { force: args.includes("--refresh"), cachedOnly: !args.includes("--refresh") });
  }
  if (command === "managed")
    return managed({
      base,
      profile,
      args,
      registry: (await read(registryPath)) || { workspaces: {} },
    });
  if (command === "setup") {
    const target = take("target");
    const directory = take("directory");
    const global = args.includes("--global");
    const remaining = args.filter((a) => a !== "--global");
    if (remaining.length) throw Error("Unsupported setup option.");
    console.log(
      JSON.stringify(await setup({ target, directory, global }), null, 2),
    );
    return;
  }
  if (command === "help") {
    console.log(`Truffle — one client, multiple workspaces.

  setup --target codex --global
  setup --target claude --global
  setup --target hermes --global
  connect product --url https://YOUR_SITE/w/product --name backend
  connect research --url https://OTHER_SITE/w/research --name backend
  managed help                 Set up and control optional managed agents
  updates [--refresh]          Check the latest release without changing any worker
  onboard                      Inspect saved setup; let the TUI ask what is missing
  activate --workspace product --runtime codex --directory PROJECT --allow-from lead
  pause --workspace product
  resume --workspace product    Reuse saved runtime, project and sender choices
  workspaces
  inbox --workspace product
  read --workspace research --room general
  send --workspace product --text "@reviewer Please review this result"
  reply --workspace product --thread MESSAGE_ID --file result.txt
  mcp-config --workspace product  Print optional MCP config using this saved identity
  context --workspace product
  pages --workspace product
  tasks --workspace product
  listen --workspace product --runtime codex --directory PROJECT --allow-from lead --background
  listener-status --workspace product
  listener-stop --workspace product
  listener-retry --workspace product --event EVENT_ID

listen supports kimi, codex and claude. Default read mode; --mode work enables project work.
--allow-from accepts exact sender IDs or bot names; "humans" explicitly trusts all human participants.
--instructions FILE adds your local work policy. --max-turns 20 caps turns per hour;
--thread-limit 4 bounds bot reply loops; --turn-timeout 300 bounds each run.
Listeners start in the background by default and return promptly.
Sessions belong to the listener, not an existing TUI. --foreground is for a dedicated worker only.
--once processes one queued event. inbox always returns immediately in the TUI.

Use --profile backend (or BOTSPACE_PROFILE) to isolate bots sharing a project.
Use --store /absolute/path/.botspace (or BOTSPACE_DIR) to reuse connections across working directories.
Private connect accepts the full invitation in --url, or --link-file FILE.
Token-only invitations remain supported with --invite-file FILE.
Reuse an existing identity: connect ALIAS --url URL --config /path/to/existing.json.
With multiple workspaces, --workspace ALIAS is required on every action.
Shared data: context, pages, page, search, write, changes, tasks, task-create, claim,
task-status, checkpoint, export. Use client help for their named arguments.
Chat commands: me, agents, rooms, join, leave, read, thread, send, reply, retry, inbox, events, ack, status. Tokens never appear in output.
Connections are stored outside the plugin. Updates preserve identities and pending sends.`);
    return;
  }
  if (command === "connect") {
    const alias = args.shift(),
      linkFile = take("link-file"),
      url =
        take("url") ||
        (linkFile
          ? (await readFile(resolve(linkFile), "utf8")).trim()
          : undefined),
      name = take("name"),
      imported = take("config");
    if (!alias || !/^[a-z][a-z0-9-]{1,39}$/.test(alias) || !url)
      throw Error(
        "connect needs ALIAS --url WORKSPACE_URL and --name BOT_NAME (or --config EXISTING_FILE).",
      );
    if (args.includes("--workspace") || args.includes("--register"))
      throw Error("Use --url for the connection address.");
    for (let i = 0; i < args.length; i += 2) {
      if (
        !["--invite-file", "--capabilities", "--provider", "--role"].includes(
          args[i],
        ) ||
        !args[i + 1] ||
        args[i + 1].startsWith("--")
      )
        throw Error("Unsupported connect option. Run help.");
    }
    const dest = target(url);
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    await writeFile(join(base, ".gitignore"), "*\n", {
      flag: "wx",
      mode: 0o600,
    }).catch((e) => {
      if (e.code !== "EEXIST") throw e;
    });
    const lock = registryPath + ".lock";
    try {
      await mkdir(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          "Another connection update is running. Retry after it finishes.",
        );
      throw e;
    }
    let inviteFile;
    try {
      const registry = (await read(registryPath)) || { workspaces: {} };
      const old = Object.hasOwn(registry.workspaces, alias)
        ? registry.workspaces[alias]
        : null;
      if (old && old.workspace !== dest.workspace)
        throw Error(
          "This alias already points to another workspace. Choose a new alias.",
        );
      const config =
        old?.config ||
        (imported
          ? resolve(imported)
          : join(base, "identities", profile + "-" + alias + ".json"));
      if (old && imported && resolve(imported) !== config)
        throw Error("This connection already has a saved identity.");
      const saved = await read(config);
      if (imported && !saved)
        throw Error("Existing config file was not found.");
      if (
        saved &&
        (saved.workspace !== dest.workspace ||
          saved.api !== dest.api ||
          !saved.token)
      )
        throw Error("Saved credential does not match this workspace.");
      const botName = name || saved?.name;
      if (!botName) throw Error("Supply --name for a new identity.");
      if (!saved && dest.invite) {
        if (args.includes("--invite-file"))
          throw Error("Choose an invitation link or --invite-file.");
        inviteFile = join(base, ".invite-" + randomUUID());
        await writeFile(inviteFile, dest.invite, { mode: 0o600, flag: "wx" });
        args.push("--invite-file", inviteFile);
      }
      const result = await run([
        "register",
        "--workspace",
        dest.workspace,
        "--name",
        botName,
        "--config",
        config,
        ...args,
      ]);
      registry.workspaces[alias] = {
        ...old,
        workspace: dest.workspace,
        name: botName,
        config,
      };
      await save(registryPath, registry);
      return {
        connected: alias,
        workspace: dest.workspace,
        name: botName,
        profile,
        reused: !!result.reused,
      };
    } finally {
      if (inviteFile) await rm(inviteFile, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  const registry = (await read(registryPath)) || { workspaces: {} };
  const entries = Object.entries(registry.workspaces);
  if (command === "onboard") {
    const workspaces = await Promise.all(
      entries.map(async ([alias, connection]) => {
        const identity = await read(connection.config);
        const status = identity
          ? await connector({
              command: "listener-status",
              args: [],
              configPath: connection.config,
              connection: identity,
            })
          : { running: false };
        return {
          alias,
          workspace: connection.workspace,
          name: connection.name,
          configured: !!connection.automation,
          ...status,
        };
      }),
    );
    const managedTeams = await Promise.all(
      (await managedConnections(base, profile)).map((c) =>
        managedStatus(base, c),
      ),
    );
    return {
      profile,
      store: base,
      workspaces,
      managed: managedTeams,
      next:
        !entries.length && !managedTeams.length
          ? "Ask which workspace to connect, then choose a bot name with the operator. Infer the runtime and current project directory."
          : [...workspaces, ...managedTeams].every(
                (w) => w.running && !w.paused && w.phase !== "reconnecting",
              )
            ? "Connected. Continue collaborating; do not repeat setup."
            : "Reuse saved identities. Leave paused connections stopped unless the operator asks to resume. Resume other configured connections only within their saved runtime/project scope; for new connections ask who may send work, then activate. Keep all setup inside this conversation.",
    };
  }
  if (command === "workspaces")
    return {
      profile,
      workspaces: entries.map(([alias, v]) => ({
        alias,
        workspace: v.workspace,
        name: v.name,
      })),
    };
  if (
    ![
      "mcp-config",
      "context",
      "knowledge",
      "executions",
      "pages",
      "page",
      "search",
      "write",
      "changes",
      "tasks",
      "task-create",
      "claim",
      "task-status",
      "checkpoint",
      "export",
      "activate",
      "resume",
      "pause",
      "listen",
      "listener-status",
      "listener-stop",
      "listener-retry",
      "me",
      "agents",
      "rooms",
      "join",
      "leave",
      "read",
      "thread",
      "send",
      "reply",
      "retry",
      "inbox",
      "events",
      "ack",
      "status",
    ].includes(command)
  )
    throw Error("Unknown command. Run help.");
  const selected = take("workspace");
  if (args.includes("--config"))
    throw Error("Use connect --config once, then select the workspace alias.");
  const alias = selected || (entries.length === 1 ? entries[0][0] : null);
  if (!alias)
    throw Error(
      entries.length
        ? "Multiple workspaces connected. Specify --workspace ALIAS."
        : "No workspaces connected. Run connect first.",
    );
  if (!Object.hasOwn(registry.workspaces, alias))
    throw Error("Unknown workspace alias. Run workspaces.");
  const connection = registry.workspaces[alias];
  const saved = await read(connection.config),
    dest = target(connection.workspace);
  if (!saved || saved.workspace !== dest.workspace || saved.api !== dest.api)
    throw Error("Saved identity no longer matches this connection.");
  if (command === "mcp-config") {
    if (args.length)
      throw Error("mcp-config takes only workspace/profile/store selectors.");
    return {
      mcpServers: {
        botspace: {
          command: process.execPath,
          args: [
            join(dirname(fileURLToPath(import.meta.url)), "swarm-mcp.mjs"),
            "--config",
            connection.config,
          ],
        },
      },
    };
  }
  if (["activate", "resume", "pause"].includes(command)) {
    if (command === "pause")
      return connector({
        command: "listener-stop",
        args: [],
        configPath: connection.config,
        connection: saved,
      });
    if (command === "resume" && args.length)
      throw Error("resume uses saved settings; use activate to change them.");
    const options =
      command === "resume" ? connection.automation?.args : [...args];
    if (!options)
      throw Error(
        "This connection needs first-time setup. Ask who may send work, then activate.",
      );
    if (options.includes("--once") || options.includes("--foreground"))
      throw Error(
        "activate keeps Truffle connected; use listen --once for a single job.",
      );
    const status = await connector({
      command: "listener-status",
      args: [],
      configPath: connection.config,
      connection: saved,
    });
    if (status.running)
      return {
        connected: true,
        alreadyRunning: true,
        ready: status.ready,
        phase: status.phase,
        workspace: connection.workspace,
      };
    const result = await connector({
      command: "listen",
      args: [...options.filter((x) => x !== "--background"), "--background"],
      configPath: connection.config,
      connection: saved,
      wrapper: fileURLToPath(import.meta.url),
      profile,
      store: base,
      alias,
    });
    if (command === "activate") {
      // Persist the exact validated choices outside the plugin so updates can resume them.
      const lock = registryPath + ".lock";
      await mkdir(lock);
      try {
        const latest = await read(registryPath);
        if (latest.workspaces[alias]?.config !== connection.config)
          throw Error(
            "Connection changed while starting. Check listener-status before continuing.",
          );
        const normalized = options.filter((x) => x !== "--background");
        for (const flag of ["--directory", "--instructions"]) {
          const i = normalized.indexOf(flag);
          if (i >= 0) normalized[i + 1] = resolve(normalized[i + 1]);
        }
        latest.workspaces[alias].automation = { args: normalized };
        await save(registryPath, latest);
      } finally {
        await rm(lock, { recursive: true, force: true });
      }
    }
    return result;
  }
  if (
    ["listen", "listener-status", "listener-stop", "listener-retry"].includes(
      command,
    )
  )
    return connector({
      command,
      args,
      configPath: connection.config,
      connection: saved,
      wrapper: fileURLToPath(import.meta.url),
      profile,
      store: base,
      alias,
    });
  if (command === "inbox" && args.includes("--wait"))
    throw Error(
      "inbox returns immediately in the TUI. Use activate/resume for background replies, or the low-level client from a dedicated worker.",
    );
  return run([command, "--config", connection.config, ...args]);
}
try {
  const result = await main();
  if (result?.releases) await recordApiReleases(base, result.releases);
  if (result && ["onboard", "context", "listener-status", "inbox", "status"].includes(command))
    result.updates = await checkUpdates(base);
  if (result) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (e) {
  process.stderr.write("Truffle: " + e.message + "\n");
  process.exitCode = 1;
}
