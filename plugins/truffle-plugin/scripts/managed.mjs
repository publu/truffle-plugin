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
import { randomUUID, createHash } from "node:crypto";

import { engineVersion, newer } from "./updates.mjs";
const runtimes = ["codex", "claude", "kimi", "hermes"];
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
// The reviewed official installer also pins platform archive checksums. Keep uv,
// downloaded Python, and Kanbot private; never change shell startup files.
export const uvBootstrap = {
  version: "0.12.19",
  url: "https://astral.sh/uv/0.12.19/install.sh",
  sha256: "61b349611f1b6e1ba33645f30c36da5287df2609dd7af8605d96a031435eb35b",
};
export function verifyUvInstaller(content) {
  if (createHash("sha256").update(content).digest("hex") !== uvBootstrap.sha256)
    throw Error(
      "The uv installer checksum did not match. No installer was executed; retry with a verified Truffle release.",
    );
}
async function ensureUv(base) {
  const directory = join(base, "engines", "bootstrap");
  await ownedPath(base, directory);
  const privateUv = join(directory, "uv");
  try {
    await access(privateUv, constants.X_OK);
    return privateUv;
  } catch {}
  const existing = await executable("uv");
  if (existing) return existing;
  const response = await fetch(uvBootstrap.url, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Error(
      `Could not download Truffle's installer (HTTP ${response.status}). Retry truffle install when connectivity is restored.`,
    );
  const content = await response.text();
  verifyUvInstaller(content);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const script = join(directory, "install-" + randomUUID() + ".sh");
  await writeFile(script, content, { mode: 0o600, flag: "wx" });
  try {
    await processRun(
      "/bin/sh",
      [script],
      {
        UV_UNMANAGED_INSTALL: directory,
        UV_INSTALL_DIR: directory,
        UV_NO_MODIFY_PATH: "1",
        UV_DISABLE_UPDATE: "1",
        UV_DOWNLOAD_URL: `https://github.com/astral-sh/uv/releases/download/${uvBootstrap.version}`,
        INSTALLER_DOWNLOAD_URL: "",
        UV_INSTALLER_GHE_BASE_URL: "",
        UV_INSTALLER_GITHUB_BASE_URL: "",
      },
      90000,
    );
    await access(privateUv, constants.X_OK);
    return privateUv;
  } finally {
    await rm(script, { force: true });
  }
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
async function engine(base, details = false) {
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
      "Truffle's Kanbot dependency is missing. Run `truffle install`, then retry; your existing agents are unchanged.",
    );
  const version = (await processRun(binary, ["--version"])).match(
    /kanbot\s+(\d+)\.(\d+)\.(\d+)/i,
  );
  if (
    !version ||
    (!details && newer(engineVersion, version.slice(1).join(".")))
  )
    throw Error(
      `Managed agents need Kanbot ${engineVersion} or newer. Run truffle managed install to install the supported runner privately.`,
    );
  return details
    ? {
        binary,
        version: version.slice(1).join("."),
        updateAvailable: newer(engineVersion, version.slice(1).join(".")),
      }
    : binary;
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
  // Older engines must remain inspectable and stoppable during an update.
  const binary = ["status", "pause"].includes(args[0])
    ? (await engine(base, true)).binary
    : await engine(base);
  const output = await processRun(binary, ["swarm", ...args], {
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
    if (["--no-start", "--missing-only"].includes(flag)) {
      result[flag.slice(2)] = true;
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
    allowed(opts, ["missing-only"]);
    let installed;
    try {
      installed = await engine(base, true);
    } catch {
      /* Missing engine can be installed privately. */
    }
    if (installed && !installed.updateAvailable)
      return {
        installed: true,
        reused: true,
        engine: "kanbot",
        version: installed.version,
        scope: "existing installation",
        next: "The engine already meets the supported version; no reinstall or downgrade was performed.",
      };
    // Native session startup installs missing dependencies, never upgrades an
    // existing engine under a worker. Explicit setup uses the update guards below.
    if (installed && opts["missing-only"])
      return {
        installed: true,
        ready: false,
        deferred: true,
        engine: "kanbot",
        version: installed.version,
        next: "Kanbot needs an update. Follow the safe update workflow when authorized; leave existing workers and pause state unchanged.",
      };
    await ownedPath(base, join(base, "engines"));
    await mkdir(join(base, "engines"), { recursive: true, mode: 0o700 });
    const lock = join(base, "engines", "install.lock");
    try {
      await mkdir(lock);
    } catch (e) {
      if (e.code === "EEXIST")
        throw Error(
          "Truffle dependency installation is already in progress. Check the installing process before retrying; do not start another installer.",
        );
      throw e;
    }
    try {
      // Recheck after acquiring the store-wide lock.
      try {
        installed = await engine(base, true);
      } catch {
        installed = null;
      }
      if (installed && !installed.updateAvailable)
        return {
          installed: true,
          reused: true,
          engine: "kanbot",
          version: installed.version,
        };
      {
        await ownedPath(base, join(base, "managed"));
        // One private engine serves every managed profile in this store. Refuse
        // replacement while any affected team is running or cannot be inspected.
        let profiles = [];
        try {
          profiles = await readdir(join(base, "managed"), {
            withFileTypes: true,
          });
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        for (const profileEntry of profiles) {
          if (
            !profileEntry.isDirectory() ||
            !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(profileEntry.name)
          )
            continue;
          for (const team of await managedConnections(
            base,
            profileEntry.name,
          )) {
            if (!team.configured) continue;
            const status = await managedStatus(base, team);
            if (
              status.available === false ||
              status.running ||
              status.active > 0 ||
              Object.entries(status.jobs || {}).some(
                ([state, count]) =>
                  count > 0 &&
                  [
                    "queued",
                    "running",
                    "delivering",
                    "remote_sending",
                    "uncertain",
                  ].includes(state),
              )
            )
              throw Error(
                "Managed update deferred: an affected team is running, has pending work, or cannot be inspected. Finish or reconcile its work, then pause only authorized teams before updating. Saved settings are unchanged.",
              );
          }
        }
      }
      if (process.platform === "win32")
        throw Error(
          "Use WSL for managed agents. Existing-session connections work on Windows.",
        );
      const uv = await ensureUv(base);
      for (const part of ["tools", "bin", "python", "cache"])
        await ownedPath(base, join(base, "engines", part));
      await processRun(
        uv,
        [
          "tool",
          "install",
          "--force",
          "--python",
          "3.11",
          `kanbot==${engineVersion}`,
        ],
        {
          UV_TOOL_DIR: join(base, "engines", "tools"),
          UV_TOOL_BIN_DIR: join(base, "engines", "bin"),
          UV_PYTHON_INSTALL_DIR: join(base, "engines", "python"),
          UV_CACHE_DIR: join(base, "engines", "cache"),
        },
        180000,
      );
      const verified = await engine(base, true);
      if (
        verified.updateAvailable ||
        verified.binary !== join(base, "engines", "bin", "kanbot")
      )
        throw Error(
          "Kanbot installation did not produce the supported private executable. Retry truffle install after checking the installation error.",
        );
      return {
        installed: true,
        engine: "kanbot",
        version: verified.version,
        scope: "private Truffle store",
        next: "Truffle dependencies are ready. Continue setup with the saved swarm, project and sender choices. No worker was started.",
      };
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
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
      const installed = await engine(base, true);
      return {
        engine: installed.binary,
        installedVersion: installed.version,
        supportedVersion: engineVersion,
        updateAvailable: installed.updateAvailable,
        runtimes: available,
        ready: !installed.updateAvailable && available.some((r) => r.installed),
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
        throw Error("Choose codex, claude, kimi, or hermes.");
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
          "Enabled managed runtimes must include the entry runtime and use codex,claude,kimi,hermes.",
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
