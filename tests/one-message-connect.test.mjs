import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const revokedMessage =
  "This agent was disconnected by the workspace owner. Ask them for a new setup.";
const json = (res, body, code = 200) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const cli = (store, profile, args, env = process.env) =>
  new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["plugins/truffle-plugin/scripts/truffle.mjs", ...args, "--store", store, "--profile", profile],
      { env },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (x) => (out += x));
    child.stderr.on("data", (x) => (err += x));
    child.on("close", (code) => done({ code, out, err }));
  });
const until = async (fn) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Condition not reached");
};

test("one multi-use setup link connects several runtimes, explains a used-up link, and rejoins after a disconnect", async () => {
  await mkdir(".cache", { recursive: true });
  const store = resolve(await mkdtemp(".cache/one-message-"));
  // A private workspace: one invite for two picked agents plus one retry.
  const invites = { INV: { maxUses: 3, uses: 0 } },
    tokens = {},
    revoked = new Set();
  let registrations = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith("/agents") && req.method === "POST") {
      const invite = invites[req.headers["x-botspace-invite"]];
      if (!invite || invite.uses >= invite.maxUses)
        return json(res, { error: "A valid invitation is required." }, 401);
      if (Object.values(tokens).includes(body.name) && ![...revoked].some((t) => tokens[t] === body.name))
        return json(res, { error: "That name is taken." }, 409);
      invite.uses++;
      registrations++;
      const token = "tok-" + body.name + "-" + registrations;
      tokens[token] = body.name;
      return json(res, { agent: { id: "id-" + registrations, name: body.name }, token }, 201);
    }
    const token = req.headers.authorization?.replace("Bearer ", "");
    if (revoked.has(token)) return json(res, { error: revokedMessage }, 401);
    if (!tokens[token]) return json(res, { error: "Workspace membership is required." }, 401);
    if (req.url.endsWith("/me")) return json(res, { id: token, name: tokens[token] });
    if (req.url.endsWith("/entities")) return json(res, { entity: body }, 201);
    json(res, { error: "unknown" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const link = (invite) => "http://127.0.0.1:" + server.address().port + "/w/team#invite=" + invite;
  const connect = (profile, name, invite = "INV") =>
    cli(store, profile, ["connect", "team", "--url", link(invite), "--name", name]);
  try {
    for (const name of ["claude-code", "codex"]) {
      const joined = await connect(name, name);
      assert.equal(joined.code, 0, joined.err);
      assert.ok(!joined.out.includes("tok-"), "tokens never appear in output");
    }
    assert.equal(registrations, 2);
    assert.equal(invites.INV.uses, 2);

    const reused = await connect("codex", "codex");
    assert.equal(JSON.parse(reused.out).reused, true);
    assert.equal(registrations, 2, "a saved identity does not spend another use");

    const sameProfile = await connect("codex", "kimi");
    assert.equal(sameProfile.code, 1);
    assert.match(sameProfile.err, /already connects @codex.*another --profile/);

    const taken = await connect("kimi", "codex");
    assert.equal(taken.code, 1);
    assert.match(taken.err, /That name is taken\. Add a number, e\.g\. codex-2\./);
    assert.equal(invites.INV.uses, 2, "a refused name does not spend a use");

    assert.equal((await connect("kimi", "kimi")).code, 0);
    // First step after connecting: add a person to Network.
    const entity = await cli(store, "kimi", ["entity", "--name", "Ada", "--kind", "company", "--summary", "Partner"]);
    assert.equal(entity.code, 0, entity.err);
    assert.deepEqual(JSON.parse(entity.out).entity, { name: "Ada", kind: "company", summary: "Partner" });
    const usedUp = await connect("hermes", "hermes");
    assert.equal(usedUp.code, 1);
    assert.match(usedUp.err, /used up, expired or was replaced\. Ask the workspace owner for a new setup message\./);
    assert.doesNotMatch(usedUp.err, /Truffle: Truffle:/);

    // The owner disconnects codex, then sends a new setup message.
    const profilePath = resolve(store, "profiles/codex.json");
    const before = JSON.parse(await readFile(profilePath, "utf8"));
    const oldConfig = before.workspaces.team.config;
    revoked.add(JSON.parse(await readFile(oldConfig, "utf8")).token);
    const automation = { args: ["--runtime", "codex", "--directory", store, "--allow-from", "owner-id"] };
    before.workspaces.team.automation = automation;
    await writeFile(profilePath, JSON.stringify(before));
    assert.match((await cli(store, "codex", ["me"])).err, /disconnected by the workspace owner/);

    invites.INV2 = { maxUses: 1, uses: 0 };
    const rejoined = await connect("codex", "codex", "INV2");
    assert.equal(rejoined.code, 0, rejoined.err);
    assert.equal(JSON.parse(rejoined.out).reused, false);
    const after = JSON.parse(await readFile(profilePath, "utf8")).workspaces.team;
    assert.notEqual(after.config, oldConfig, "a fresh identity file avoids the dead token");
    assert.deepEqual(after.automation, automation, "saved runtime and sender choices survive");
    await access(oldConfig);
    assert.equal((await cli(store, "codex", ["me"])).code, 0);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

async function listenerFixture(heartbeatReply) {
  await mkdir(".cache", { recursive: true });
  const dir = resolve(await mkdtemp(".cache/heartbeat-"));
  const bin = dir + "/bin";
  await mkdir(bin);
  await writeFile(
    bin + "/codex",
    `#!${process.execPath}\nfor await(const c of process.stdin);console.log(JSON.stringify({type:'thread.started',thread_id:'t'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Done'}}));\n`,
    { mode: 0o700 },
  );
  const f = { dir, heartbeats: 0, posts: [], events: [] };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, "http://test");
    const path = url.pathname;
    if (path.endsWith("/heartbeat")) {
      f.heartbeats++;
      return heartbeatReply(res, f);
    }
    if (f.revoked) return json(res, { error: revokedMessage }, 401);
    if (path.endsWith("/me")) return json(res, { id: "worker" });
    if (path.endsWith("/agents")) return json(res, { agents: [{ id: "owner-id", name: "owner" }] });
    if (path.endsWith("/inbox")) {
      const items = f.events.filter((e) => e.id > Number(url.searchParams.get("after") || 0));
      return json(res, { events: items, cursor: items.at(-1)?.id || 0 });
    }
    if (path.includes("/threads/"))
      return json(res, { root: { id: "root", room: "general", author: "owner-id", body: "Hi" }, replies: [] });
    if (path.endsWith("/posts")) {
      f.posts.push(body);
      return json(res, body);
    }
    if (path.endsWith("/ack")) return json(res, { ok: true });
    json(res, { error: "unknown" }, 404);
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => ws.on("message", (m) => m.toString() === "ping" && ws.send("pong")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const store = dir + "/store",
    config = store + "/identity.json";
  await mkdir(store + "/profiles", { recursive: true });
  await writeFile(config, JSON.stringify({ workspace: origin + "/w/test", api: origin + "/api/w/test", name: "worker", agentId: "worker", token: "test-token" }));
  await writeFile(store + "/profiles/worker.json", JSON.stringify({ workspaces: { test: { workspace: origin + "/w/test", config, name: "worker" } } }));
  const env = { ...process.env, PATH: bin + ":" + process.env.PATH };
  f.command = (...args) => cli(store, "worker", [...args, "--workspace", "test"], env);
  f.notify = () => wss.clients.forEach((ws) => ws.send(JSON.stringify({ type: "inbox" })));
  f.activate = () => f.command("activate", "--runtime", "codex", "--directory", dir, "--allow-from", "owner");
  f.close = async () => {
    await f.command("listener-stop");
    await until(async () => !JSON.parse((await f.command("listener-status")).out).running).catch(() => {});
    server.closeAllConnections();
    wss.close();
    await new Promise((r) => server.close(r));
  };
  return f;
}

test("a disconnected agent's listener stops once and reports the owner's reason", async () => {
  const f = await listenerFixture((res, f) => {
    f.revoked = true;
    json(res, { error: revokedMessage }, 401);
  });
  try {
    await f.activate();
    let status;
    await until(async () => {
      status = JSON.parse((await f.command("listener-status")).out);
      return !status.running && status.lastError;
    });
    assert.match(status.lastError, /disconnected by the workspace owner\. Ask them for a new setup\./);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(f.heartbeats, 1, "no retry against a revoked token");
    // Starting again explains the reason instead of pointing at a log file.
    const again = await f.activate();
    assert.equal(again.code, 1);
    assert.match(again.err, /disconnected by the workspace owner/);
  } finally {
    await f.close();
  }
});

test("a rate-limited heartbeat backs off while work continues", async () => {
  const f = await listenerFixture((res) => json(res, { error: "Too many writes. Try again in a minute." }, 429));
  try {
    const started = await f.activate();
    assert.equal(started.code, 0, started.err);
    await until(() => f.heartbeats === 1);
    // A new job normally sends a heartbeat; within the backoff it must not.
    f.events.push({ id: 1, type: "message", actor: "owner-id", objectId: "root" });
    f.notify();
    await until(() => f.posts.length === 1);
    assert.equal(f.heartbeats, 1);
    assert.equal(JSON.parse((await f.command("listener-status")).out).running, true);
  } finally {
    await f.close();
  }
});
