import { readFile, writeFile } from "node:fs/promises";
export const sharedCommands = [
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
];
export async function sharedOperation(command, options, api) {
  const need = (key) => {
    if (!options[key]) throw Error(`Missing --${key}`);
    return options[key];
  };
  const number = (key) => {
    const n = Number(need(key));
    if (!Number.isSafeInteger(n) || n < 0) throw Error(`Invalid --${key}`);
    return n;
  };
  const query = (values) => {
    const q = new URLSearchParams(
      Object.entries(values).filter(([, v]) => v !== undefined),
    );
    return q.size ? "?" + q : "";
  };
  switch (command) {
    case "context":
      return api("/context" + query({ task: options.task, thread: options.thread }));
    case "knowledge":
      return api("/knowledge" + query({ q: options.query, task: options.task }));
    case "executions":
      return api("/executions" + query({ id: options.id, root: options.root }));
    case "pages":
      return api("/wiki");
    case "page":
      return api(
        "/wiki/page" + query({ id: need("id"), revision: options.revision }),
      );
    case "search":
      return api(
        "/wiki/search" + query({ q: need("query"), budget: options.budget }),
      );
    case "changes":
      return api("/wiki/changes" + query({ after: options.after }));
    case "write":
      return api("/wiki", {
        id: need("id"),
        title: need("title"),
        body: await readFile(need("file"), "utf8"),
        expectedRevision: number("revision"),
        sources: options.source ? [options.source] : [],
        ...(options.task ? { task: options.task } : {}),
      });
    case "tasks":
      return api("/tasks");
    case "task-create":
      return api("/tasks", {
        id: need("id"),
        title: need("title"),
        room: options.room || "general",
        owner: options.owner || "",
        dependencies: options.dependencies?.split(",") || [],
        ...(options.intent ? { intent: options.intent } : {}),
        ...(options.file || options.request ? { request: options.file ? await readFile(options.file, "utf8") : options.request } : {}),
        ...(options.criteria ? { criteria: JSON.parse(options.criteria) } : {}),
      });
    case "claim":
      return api("/claim", { id: need("id") });
    case "task-status":
      return api("/task-status", {
        id: need("id"),
        version: number("version"),
        status: need("status"),
        result: options.result || "",
        artifact: options.artifact || "",
      });
    case "checkpoint":
      return api("/checkpoint", {
        id: need("id"),
        version: number("version"),
        summary: options.file
          ? await readFile(options.file, "utf8")
          : need("summary"),
      });
    case "export": {
      const path = need("file");
      let after,
        version,
        pages = [];
      for (let i = 0; i < 11; i++) {
        const result = await api(
          "/wiki/export" +
            query({
              after,
              version: version === undefined ? undefined : String(version),
            }),
        );
        version ??= result.version;
        pages.push(...result.pages);
        if (!result.hasMore) {
          await writeFile(
            path,
            JSON.stringify(
              { format: "botspace.wiki.v1", version, pages },
              null,
              2,
            ) + "\n",
            { flag: "wx", mode: 0o600 },
          );
          return { exported: pages.length, file: path, version };
        }
        after = result.nextAfter;
      }
      throw Error("Export exceeded the workspace page limit.");
    }
  }
}
