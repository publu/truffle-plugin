import {
  access,
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  stat,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join, delimiter, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const engineVersion = "0.9.5";
const runtimes = ["codex", "claude", "kimi"];
const aliasPattern = /^[a-z][a-z0-9-]{1,39}$/;
const root = (base, profile) => join(base, "managed", profile);
async function ownedPath(base, path) {
  const tail = relative(base, path);
  if (tail.startsWith("..") || tail.startsWith(sep))
    throw Error("Managed path must remain inside this Truffle store.");
  let current = base;
  for (const part of ["", ...tail.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw Error(
          "Refusing a symlinked managed path. Keep each team in its own private store.",
        );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
}
async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
async function save(path, value) {
  await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
async function executable(name) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    const file = resolve(dir, name);
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {}
  }
  return null;
}
function safeError(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
    .replace(/([#?&](?:invite|token|key)=)[^\s&]+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_=-]{32,}\b/g, "[redacted]")
    .slice(-2000);
}
function processRun(binary, args, env = {}, timeout = 35000) {
  return new Promise((resolveRun, reject) => {
    const childEnv = { ...process.env, ...env };
    if (env.KANBOT_HOME) {
      delete childEnv.KANBOT_SOCK;
      delete childEnv.KANBOT_DB;
    }
    const child = spawn(binary, args, {
      env: childEnv,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "",
      failure = "",
      settled = false,
      escalation;
    const kill = (signal) => {
      try {
        process.platform === "win32"
          ? child.kill(signal)
          : process.kill(-child.pid, signal);
      } catch {}
    };
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalation);
      error ? reject(error) : resolveRun(value);
    };
    const stop = (reason) => {
      if (failure) return;
      failure = reason;
      kill("SIGTERM");
      escalation = setTimeout(() => {
        kill("SIGKILL");
        finish(Error(failure));
      }, 2000);
    };
    const timer = setTimeout(
      () =>
        stop(
          "Managed command timed out. Check managed status before retrying; work may still be running.",
        ),
      timeout,
    );
    child.stdout.on("data", (x) => {
      if (failure) return;
      if (out.length + x.length > 2_000_000)
        stop(
          "Managed runner response exceeded its limit. Check managed status before retrying.",
        );
      else out += x;
    });
    child.stderr.on("data", (x) => {
      err = (err + x).slice(-8000);
    });
    child.once("error", (e) => finish(e));
    child.once("close", (code) =>
      finish(
        failure
          ? Error(failure)
          : code !== 0
            ? Error(safeError(err.trim()) || "Managed runner command failed.")
            : null,
        out,
      ),
    );
  });
}
async function engine(base) {
  if (process.platform === "win32")
    throw Error(
      "Managed agents require macOS, Linux, or WSL. Existing-session connections still work on Windows.",
    );
  const owned = join(base, "engines", "bin", "kanbot");
  await ownedPath(base, join(base, "engines", "bin")); // uv owns the executable symlink within this directory.
  let binary;
  try {
    await access(owned, constants.X_OK);
    binary = owned;
  } catch {
    binary = await executable("kanbot");
  }
  if (!binary)
    throw Error(
      "Managed agents need the optional runner. Run `truffle managed install`, then retry; your existing agents are unchanged.",
    );
  const version = (await processRun(binary, ["--version"])).match(
    /kanbot\s+(\d+)\.(\d+)\.(\d+)/i,
  );
  if (
    !version ||
    (Number(version[1]) === 0 &&
      (Number(version[2]) < 9 ||
        (Number(version[2]) === 9 && Number(version[3]) < 5)))
  )
    throw Error(
      "Managed agents need Kanbot 0.9.5 or newer. Run `truffle managed install` to install the supported runner privately.",
    );
  return binary;
}
function clean(result) {
  if (Array.isArray(result)) return result.map(clean);
  if (result && typeof result === "object")
    return Object.fromEntries(
      Object.entries(result)
        .filter(([key]) => !/token|secret|invite|authorization/i.test(key))
        .map(([k, v]) => [k, clean(v)]),
    );
  return result;
}
async function invoke(base, connection, args) {
  const output = await processRun(await engine(base), ["swarm", ...args], {
    KANBOT_HOME: connection.home,
  });
  try {
    return clean(JSON.parse(output));
  } catch (e) {
    throw Error(
      "Managed runner returned an invalid response. Check managed status before retrying.",
    );
  }
}
export async function managedConnections(base, profile) {
  await ownedPath(base, root(base, profile));
  let entries;
  try {
    entries = await readdir(root(base, profile), { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const result = [];
  for (const entry of entries)
    if (entry.isDirectory() && aliasPattern.test(entry.name)) {
      const value = await read(
        join(root(base, profile), entry.name, "connection.json"),
      );
      if (value) {
        const expected = join(root(base, profile), entry.name, "runner");
        await ownedPath(
          base,
          join(root(base, profile), entry.name, "connection.json"),
        );
        await ownedPath(base, expected);
        if (value.home !== expected || value.alias !== entry.name)
          throw Error(
            "Managed runner home does not match this workspace. Restore the original connection file.",
          );
        result.push({ ...value, alias: entry.name, home: expected });
      }
    }
  return result;
}
export async function managedStatus(base, connection) {
  const summary = {
    alias: connection.alias,
    workspace: connection.workspace,
    name: connection.name,
    runtime: connection.runtime,
    directory: connection.directory,
    mode: connection.mode,
    configured: connection.configured,
    engine: "kanbot",
  };
  try {
    return { ...summary, ...(await invoke(base, connection, ["status"])) };
  } catch (e) {
    return { ...summary, running: false, available: false, error: e.message };
  }
}
function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith("--") || Object.hasOwn(result, flag.slice(2)))
      throw Error("Use named managed options once each. Run managed help.");
    if (flag === "--no-start") {
      result["no-start"] = true;
      continue;
    }
    if (!argv[i + 1] || argv[i + 1].startsWith("--"))
      throw Error("Missing " + flag + " value");
    result[flag.slice(2)] = argv[++i];
  }
  return result;
}
function allowed(opts, keys) {
  for (const key of Object.keys(opts))
    if (!keys.includes(key)) throw Error("Unsupported managed option --" + key);
}
function destination(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    !/^\/w\/[a-z][a-z0-9-]{2,39}\/?$/.test(url.pathname) ||
    (url.protocol === "http:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
  )
    throw Error(
      "Use an HTTPS swarm URL (HTTP is supported only on localhost).",
    );
  return {
    workspace: url.origin + url.pathname.replace(/\/$/, ""),
    invite: new URLSearchParams(url.hash.slice(1)).get("invite") || "",
  };
}
export async function managed({
  base,
  profile,
  args,
  registry = { workspaces: {} },
}) {
  const command = args[0] || "help";
  let opts = options(args.slice(1));
  if (command === "help")
    return {
      commands: [
        "managed install",
        "managed doctor",
        "managed connect --workspace ALIAS --url URL --runtime codex --directory PROJECT --allow-from SENDER_ID",
        "managed status|pause|resume --workspace ALIAS",
        "managed send --workspace ALIAS --to NAME --file TASK --request-id STABLE_ID",
        "managed job|cancel --workspace ALIAS --id JOB_ID",
      ],
      note: "Your agent handles setup. Existing-session connections stay independent. Reconnecting preserves saved settings and pause.",
    };
  if (command === "install") {
    allowed(opts, []);
    if (process.platform === "win32")
      throw Error(
        "Use WSL for managed agents. Existing-session connections work on Windows.",
      );
    const uv = await executable("uv");
    if (!uv)
      throw Error(
        "Install uv from https://docs.astral.sh/uv/getting-started/installation/, then run managed install.",
      );
    await ownedPath(base, join(base, "engines"));
    await mkdir(join(base, "engines"), { recursive: true, mode: 0o700 });
    await processRun(
      uv,
      ["tool", "install", "--force", `kanbot==${engineVersion}`],
      {
        UV_TOOL_DIR: join(base, "engines", "tools"),
        UV_TOOL_BIN_DIR: join(base, "engines", "bin"),
      },
      180000,
    );
    return {
      installed: true,
      engine: "kanbot",
      version: engineVersion,
      scope: "private Truffle store",
      next: "Continue managed connect with the saved swarm, project and sender choices.",
    };
  }
  if (command === "doctor") {
    allowed(opts, []);
    const available = await Promise.all(
      runtimes.map(async (runtime) => ({
        runtime,
        installed: !!(await executable(runtime)),
        authentication: "not checked",
      })),
    );
    try {
      return {
        engine: await engine(base),
        runtimes: available,
        ready: available.some((r) => r.installed),
        note: "Runtime login and task execution are verified by the actual task, not by binary presence.",
      };
    } catch (e) {
      return { ready: false, error: e.message, runtimes: available };
    }
  }
  const connections = await managedConnections(base, profile);
  if (command === "status" && !opts.workspace) {
    allowed(opts, []);
    return {
      managed: await Promise.all(
        connections.map((c) => managedStatus(base, c)),
      ),
    };
  }
  const alias =
    opts.workspace || (connections.length === 1 ? connections[0].alias : null);
  if (!alias || !aliasPattern.test(alias))
    throw Error(
      "Choose --workspace ALIAS; this selects the saved swarm without asking for its URL again.",
    );
  const home = join(root(base, profile), alias, "runner"),
    file = join(root(base, profile), alias, "connection.json");
  let connection = connections.find((c) => c.alias === alias);
  if (command === "connect") {
    allowed(opts, [
      "workspace",
      "url",
      "link-file",
      "invite-file",
      "name",
      "runtime",
      "directory",
      "allow-from",
      "mode",
      "instructions",
      "concurrency",
      "max-agents",
      "max-turns",
      "max-depth",
      "timeout",
      "runtimes",
      "model",
      "no-start",
    ]);
    const value =
      opts.url ||
      (opts["link-file"]
        ? (await readFile(resolve(opts["link-file"]), "utf8")).trim()
        : null) ||
      connection?.workspace ||
      registry.workspaces[alias]?.workspace;
    if (!value)
      throw Error("Supply the swarm URL once with --url or --link-file.");
    const dest = destination(value);
    if (
      connection?.workspace !== undefined &&
      connection.workspace !== dest.workspace
    )
      throw Error(
        "This alias already belongs to another swarm. Choose another alias.",
      );
    const prior = connection;
    if (!connection || !connection.configured) {
      if (connection) {
        if (opts.name && opts.name !== connection.name)
          throw Error("Keep the registered entry name when repairing setup.");
        opts = {
          ...connection.settings,
          name: connection.name,
          runtime: connection.runtime,
          directory: connection.directory,
          mode: connection.mode,
          "allow-from": connection.allowFrom,
          concurrency: connection.concurrency,
          ...opts,
        };
      }
      if (!opts.runtime || !opts.directory || !opts["allow-from"])
        throw Error(
          "First setup needs --runtime, --directory and --allow-from. Reuse the operator’s existing choices.",
        );
      if (!runtimes.includes(opts.runtime))
        throw Error(
          "Managed agents support Codex, Claude and Kimi. Hermes can connect in its existing conversation; choose a supported managed runtime.",
        );
      const directory = resolve(opts.directory);
      if (!(await stat(directory)).isDirectory())
        throw Error("Choose an existing project directory.");
      if (!(await executable(opts.runtime)))
        throw Error(
          `${opts.runtime} is not installed. Connect an installed runtime, or install and sign in to ${opts.runtime} first.`,
        );
      if (opts.mode && !["read", "work"].includes(opts.mode))
        throw Error("Choose --mode read or --mode work.");
      const name = opts.name || "truffle-team";
      if (!/^[a-z][a-z0-9-]{1,39}$/.test(name))
        throw Error(
          "Use a short agent name with lowercase letters, numbers and hyphens.",
        );
      if (
        !opts["allow-from"].trim() ||
        opts["allow-from"]
          .split(",")
          .some((x) => ["*", "humans", "all"].includes(x.trim()))
      )
        throw Error(
          "Use explicit trusted sender IDs; managed agents do not enable blanket trust.",
        );
      const concurrency = Number(opts.concurrency || 2);
      if (
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 100
      )
        throw Error("Choose concurrency from 1 to 100.");
      connection = {
        alias,
        workspace: dest.workspace,
        home,
        name,
        runtime: opts.runtime,
        directory,
        mode: opts.mode || "read",
        allowFrom: opts["allow-from"],
        concurrency,
        configured: false,
        settings: {},
      };
      for (const key of [
        "instructions",
        "max-agents",
        "max-turns",
        "max-depth",
        "timeout",
        "runtimes",
        "model",
      ])
        if (opts[key])
          connection.settings[key] =
            key === "instructions" ? resolve(opts[key]) : opts[key];
    } else {
      for (const [key, field] of [
        ["name", "name"],
        ["runtime", "runtime"],
        ["directory", "directory"],
        ["mode", "mode"],
        ["allow-from", "allowFrom"],
        ["concurrency", "concurrency"],
      ])
        if (
          opts[key] !== undefined &&
          String(key === "directory" ? resolve(opts[key]) : opts[key]) !==
            String(connection[field])
        )
          throw Error(
            "Saved " +
              key +
              " differs. Reconnecting preserves the existing permissions and settings; use another alias for a separate team.",
          );
      for (const key of [
        "instructions",
        "max-agents",
        "max-turns",
        "max-depth",
        "timeout",
        "runtimes",
        "model",
      ])
        if (
          opts[key] !== undefined &&
          String(key === "instructions" ? resolve(opts[key]) : opts[key]) !==
            String(connection.settings?.[key])
        )
          throw Error(
            "Saved " +
              key +
              " differs; reconnecting preserves existing settings.",
          );
    }
    for (const [key, min, max] of [
      ["max-agents", connection.concurrency, 10000],
      ["max-turns", 1, 10000],
      ["max-depth", 1, 20],
      ["timeout", 10, 3600],
    ])
      if (connection.settings[key] !== undefined) {
        const n = Number(connection.settings[key]);
        if (!Number.isInteger(n) || n < min || n > max)
          throw Error("Choose " + key + " from " + min + " to " + max + ".");
      }
    if (connection.settings.runtimes) {
      const selected = connection.settings.runtimes.split(",");
      if (
        selected.some((r) => !runtimes.includes(r)) ||
        !selected.includes(connection.runtime)
      )
        throw Error(
          "Enabled managed runtimes must include the entry runtime and use codex,claude,kimi.",
        );
    }
    if (connection.settings.instructions)
      await readFile(connection.settings.instructions, "utf8");
    await ownedPath(base, file);
    await ownedPath(base, home);
    await engine(base); // Fail before writing a connection if installation is missing.
    await mkdir(resolve(file, ".."), { recursive: true, mode: 0o700 });
    const lock = file + ".lock";
    try {
      await mkdir(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          "Another managed setup is running. Retry when it finishes.",
        );
      throw e;
    }
    let inviteFile;
    try {
      // Reload inside the lock so parallel setup cannot overwrite a registered identity.
      const latest = await read(file);
      if (JSON.stringify(latest) !== JSON.stringify(prior || null))
        throw Error(
          "Managed setup changed during connection. Check status and retry.",
        );
      if (connection.configured)
        return {
          ...(await managedStatus(base, connection)),
          reused: true,
          next: "Saved setup reused. Paused agents stay paused; use managed resume only when requested.",
        };
      await save(file, connection);
      const argv = [
        "connect",
        connection.workspace,
        "--name",
        connection.name,
        "--runtime",
        connection.runtime,
        "--directory",
        connection.directory,
        "--mode",
        connection.mode,
        "--allow-from",
        connection.allowFrom,
        "--concurrency",
        String(connection.concurrency),
        "--no-start",
      ];
      for (const [key, value] of Object.entries(connection.settings))
        argv.push("--" + key, value);
      if (dest.invite && opts["invite-file"])
        throw Error("Use one invitation source.");
      if (dest.invite) {
        inviteFile = join(resolve(file, ".."), ".invite-" + randomUUID());
        await writeFile(inviteFile, dest.invite, { mode: 0o600, flag: "wx" });
        argv.push("--invite-file", inviteFile);
      } else if (opts["invite-file"])
        argv.push("--invite-file", resolve(opts["invite-file"]));
      const result = await invoke(base, connection, argv);
      if (result.reused && prior) {
        connection = { ...prior, configured: true };
        await save(file, connection);
        return {
          ...(await managedStatus(base, connection)),
          reused: true,
          next: "The prior setup completed. Saved settings and pause were preserved.",
        };
      }
      connection.configured = true;
      await save(file, connection);
      // Only the initial explicit connect starts a new runner. Retry/reconnect never resumes one.
      const service = opts["no-start"]
        ? { running: false, paused: true }
        : await invoke(base, connection, ["start"]);
      return {
        ...result,
        alias,
        engine: "kanbot",
        service,
        next: opts["no-start"]
          ? "Saved and paused."
          : "Check managed status, then submit the saved task once with its stable request ID.",
      };
    } finally {
      if (inviteFile) await rm(inviteFile, { force: true });
      await rm(lock, { recursive: true, force: true });
    }
  }
  if (!connection)
    throw Error(
      "No managed team saved for this workspace. Run managed connect first.",
    );
  if (["status", "pause", "resume"].includes(command)) {
    allowed(opts, ["workspace"]);
    if (command === "status") return managedStatus(base, connection);
    return invoke(base, connection, [command === "resume" ? "start" : "pause"]);
  }
  if (command === "send") {
    allowed(opts, ["workspace", "to", "file", "text", "task", "request-id"]);
    if ((opts.file && opts.text) || (!opts.file && !opts.text && !opts.task))
      throw Error(
        "Supply --task, --file, or --text; use only one text source.",
      );
    if (!opts["request-id"])
      throw Error(
        "Use --request-id with the saved task ID so retrying does not submit duplicate work.",
      );
    return invoke(base, connection, [
      "send",
      opts.to || connection.name,
      ...(opts.file
        ? ["--file", resolve(opts.file)]
        : opts.text
          ? ["--text", opts.text]
          : []),
      ...(opts.task ? ["--task", opts.task] : []),
      "--request-id",
      opts["request-id"],
    ]);
  }
  if (["job", "cancel"].includes(command)) {
    allowed(opts, ["workspace", "id"]);
    if (!opts.id) throw Error("Supply --id JOB_ID.");
    return invoke(base, connection, [command, opts.id]);
  }
  throw Error("Unknown managed command. Run managed help.");
}
