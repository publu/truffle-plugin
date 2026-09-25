import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { WebSocketServer } from "ws";

test("downloadable client persists identity and retries an accepted send after a lost response", async () => {
  await mkdir(".cache/client-tests", { recursive: true });
  const dir = await mkdtemp(".cache/client-tests/run-");
  let registrations = 0,
    dropResponse = true;
  const posts = new Map(),
    attempts = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const send = (data, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.url === "/api/w/test-space/agents" && req.method === "POST") {
      registrations++;
      return send({
        agent: { id: "agent-test", name: body.name },
        token: "test-client-secret",
        guidance: { version: 1, actor: "agent-test", stage: "registered" },
      });
    }
    if (req.headers.authorization !== "Bearer test-client-secret")
      return send({ error: "Unauthorized" }, 401);
    if (req.url === "/api/w/test-space/me")
      return send({
        id: "agent-test",
        agent: { name: "client-test" },
        rooms: [],
      });
    if (req.url === "/api/w/test-space/posts") {
      attempts.push(body.id);
      posts.set(body.id, { ...body, author: "agent-test" });
      if (dropResponse) {
        dropResponse = false;
        req.socket.destroy();
        return;
      }
      return send(posts.get(body.id), 201);
    }
    if (req.url === "/api/w/test-space/threads/reply-id")
      return send({
        root: { id: "root-id", room: "project-room" },
        replies: [],
      });
    if (req.url.startsWith("/api/w/test-space/inbox"))
      return send({ events: [], cursor: 0, hasMore: false });
    return send({ error: "Unknown path" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const sockets = new WebSocketServer({ server });
  const workspace =
      "http://127.0.0.1:" + server.address().port + "/w/test-space",
    config = resolve(dir, "agent.json");
  const run = (...args) =>
    new Promise((resolveResult) => {
      const child = spawn(
        process.execPath,
        [resolve("plugins/truffle-plugin/scripts/client.mjs"), ...args, "--config", config],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (x) => (stdout += x));
      child.stderr.on("data", (x) => (stderr += x));
      child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    });
  try {
    const registered = await run(
      "register",
      "--workspace",
      workspace,
      "--name",
      "client-test",
    );
    assert.equal(registered.code, 0, registered.stderr);
    assert.ok(!registered.stdout.includes("test-client-secret"));
    assert.equal(JSON.parse(registered.stdout).guidance.stage, "registered");
    assert.equal((await stat(config)).mode & 0o777, 0o600);
    assert.equal(
      (await run("register", "--workspace", workspace, "--name", "client-test"))
        .code,
      0,
    );
    assert.equal(registrations, 1);
    assert.equal(
      (await run("register", "--workspace", workspace, "--name", "another-bot"))
        .code,
      1,
    );
    const first = await run("send", "--text", "A result");
    assert.equal(first.code, 1);
    const pending = JSON.parse(await readFile(config + ".outbox", "utf8"));
    assert.equal(posts.size, 1);
    assert.equal((await run("send", "--text", "A different result")).code, 1);
    assert.equal(posts.size, 1);
    const retry = await run("retry");
    assert.equal(retry.code, 0, retry.stderr);
    assert.equal(posts.size, 1);
    assert.deepEqual(attempts, [pending.id, pending.id]);
    await assert.rejects(readFile(config + ".outbox"), { code: "ENOENT" });
    const reply = await run(
      "reply",
      "--thread",
      "reply-id",
      "--text",
      "Reviewed",
    );
    assert.equal(reply.code, 0, reply.stderr);
    const sent = JSON.parse(reply.stdout);
    assert.equal(sent.parent, "root-id");
    assert.equal(sent.room, "project-room");
    const waited = await run("inbox", "--wait", "--timeout", "1");
    assert.equal(waited.code, 0, waited.stderr);
    assert.deepEqual(JSON.parse(waited.stdout).events, []);
    const identity = await run("me");
    assert.equal(JSON.parse(identity.stdout).id, "agent-test");
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((r) => sockets.close(r));
    await new Promise((r) => server.close(r));
  }
});
