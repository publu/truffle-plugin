import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  chmod,
  stat,
} from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

test("a listener outlives its plugin folder, names the cause while reconnecting, and exits when its client is gone", async () => {
  await mkdir(".cache", { recursive: true });
  const dir = resolve(await mkdtemp(".cache/update-"));
  const bin = dir + "/bin";
  await mkdir(bin);
  await writeFile(
    bin + "/codex",
    `#!${process.execPath}\nfor await(const c of process.stdin);console.log(JSON.stringify({type:'thread.started',thread_id:'owned'}));console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified reply'}}));\n`,
    { mode: 0o700 },
  );
  // The installed plugin: a versioned folder that the next update deletes.
  const installed = dir + "/plugin-0.0.1/scripts";
  await cp("plugins/truffle-plugin", dir + "/plugin-0.0.1", { recursive: true });
  await chmod(installed + "/client.mjs", 0o444);
  const events = [],
    posts = [],
    acks = [],
    afters = [];
  let rejectInbox = false,
    rejected = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, "http://test");
    const send = (v) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (url.pathname.endsWith("/me")) return send({ id: "worker" });
    if (url.pathname.endsWith("/agents"))
      return send({ agents: [{ id: "lead-id", name: "lead" }] });
    if (url.pathname.endsWith("/inbox")) {
      if (rejectInbox) {
        rejected++;
        res.statusCode = 400;
        return send({ error: "inbox refused" });
      }
      const after = Number(url.searchParams.get("after") || 0);
      afters.push(after);
      const items = events.filter((e) => e.id > after && !acks.includes(e.id));
      return send({ events: items, cursor: items.at(-1)?.id || 0 });
    }
    if (url.pathname.includes("/threads/"))
      return send({
        root: {
          id: "root",
          room: "general",
          author: "lead-id",
          body: "Review",
        },
        replies: [],
      });
    if (url.pathname.endsWith("/posts")) {
      posts.push(body);
      return send(body);
    }
    if (url.pathname.endsWith("/ack")) {
      acks.push(...body.ids);
      return send({ ok: true });
    }
    res.statusCode = 404;
    send({ error: "unknown" });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) =>
    ws.on("message", (m) => {
      if (m.toString() === "ping") ws.send("pong");
    }),
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  const store = dir + "/store",
    config = store + "/identity.json";
  await mkdir(store + "/profiles", { recursive: true });
  await writeFile(
    config,
    JSON.stringify({
      workspace: origin + "/w/test",
      api: origin + "/api/w/test",
      name: "worker",
      agentId: "worker",
      token: "test-token",
    }),
  );
  await writeFile(
    store + "/profiles/worker.json",
    JSON.stringify({
      workspaces: {
        test: { workspace: origin + "/w/test", config, name: "worker" },
      },
    }),
  );
  const command = (cli, ...args) =>
    new Promise((resolve) => {
      const p = spawn(
        process.execPath,
        [cli, ...args, "--profile", "worker", "--store", store],
        { env: { ...process.env, PATH: bin + ":" + process.env.PATH } },
      );
      let out = "",
        err = "";
      p.stdout.on("data", (x) => (out += x));
      p.stderr.on("data", (x) => (err += x));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  // The repository copy stands in for the updated plugin that later sessions use.
  const current = "plugins/truffle-plugin/scripts/truffle.mjs";
  const status = async () =>
    JSON.parse((await command(current, "listener-status")).out);
  const saved = async () =>
    JSON.parse(await readFile(config + ".listener.json", "utf8"));
  const until = async (fn, tries = 100) => {
    for (let i = 0; i < tries; i++) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("Condition not reached");
  };
  const deliver = (id) => {
    events.push({
      id,
      type: "message",
      actor: "lead-id",
      objectId: "root",
      text: "Review",
    });
    for (const ws of wss.clients) ws.send(JSON.stringify({ type: "inbox" }));
  };
  try {
    const start = await command(
      installed + "/truffle.mjs",
      "activate",
      "--runtime",
      "codex",
      "--directory",
      dir,
      "--allow-from",
      "lead",
    );
    assert.equal(start.code, 0, start.err);
    assert.equal(JSON.parse(start.out).listening, true);
    assert.match((await status()).pluginVersion, /^\d+\.\d+\.\d+$/);
    await until(() => afters.includes(0));

    // The install is read-only. The listener's copy must not inherit that, or the next start cannot replace it.
    assert.equal(
      (await stat(config + ".listener.client.mjs")).mode & 0o777,
      0o600,
    );
    await command(current, "pause");
    await until(async () => !(await status()).running);
    const waits = afters.length;
    const again = await command(installed + "/truffle.mjs", "resume");
    assert.equal(again.code, 0, again.err);
    assert.equal(JSON.parse(again.out).listening, true);
    await until(() => afters.length > waits);
    assert.equal((await status()).phase, "listening");

    // The update removes the folder this listener was started from.
    await rm(dir + "/plugin-0.0.1", { recursive: true, force: true });
    deliver(1);
    await until(() => acks.includes(1));
    assert.equal(posts.length, 1);
    // The wait that follows must start without the deleted folder.
    await until(() => afters.includes(1));
    assert.equal((await status()).phase, "listening");
    deliver(2);
    await until(() => acks.includes(2));
    assert.equal(posts.length, 2);
    await until(() => afters.includes(2));

    // A failing wait reports why and since when, and onboard stops claiming a connection.
    rejectInbox = true;
    for (const ws of wss.clients) ws.send(JSON.stringify({ type: "inbox" }));
    await until(() => rejected >= 2);
    await until(async () => {
      const seen = JSON.parse((await command(current, "onboard")).out);
      if (seen.workspaces[0].phase !== "reconnecting") return false;
      assert.match(seen.workspaces[0].lastError, /Cause: .*HTTP 400/);
      assert.ok(seen.workspaces[0].phaseSince <= Date.now());
      assert.doesNotMatch(seen.next, /^Connected/);
      return true;
    });
    const log = await readFile(config + ".listener.log", "utf8");
    assert.equal(
      log.split("\n").filter((l) => l.includes('"type":"reconnecting"')).length,
      1,
      "repeated failures must not flood the log",
    );
    assert.match(log, /"type":"reconnecting".*HTTP 400/);
    rejectInbox = false;
    deliver(3);
    // The retry backoff may hold the next attempt for several seconds.
    await until(() => acks.includes(3), 400);
    await until(async () => (await saved()).jobs[3]?.status === "done");
    const recovered = await saved();
    assert.equal(recovered.lastError, undefined);
    assert.equal(recovered.phaseSince, undefined);
    await until(() => afters.includes(3));

    // Without its client the listener can never hear again: it must exit, not retry forever.
    await rm(config + ".listener.client.mjs");
    deliver(4);
    await until(() => acks.includes(4));
    await until(async () => !(await status()).running);
    const stopped = await status();
    assert.equal(stopped.phase, "stopped");
    assert.equal(stopped.paused, false, "a crash is not an operator pause");
    assert.match(stopped.lastError, /client file was removed/);
    assert.match(
      await readFile(config + ".listener.log", "utf8"),
      /Truffle: Listener client file was removed/,
      "the wrapper reports the failure and exits non-zero",
    );
  } finally {
    await command(current, "pause");
    await until(async () => !(await status()).running);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
