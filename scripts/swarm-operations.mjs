import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { planContactImport, sendContactBatch } from "./contact-import.mjs";
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
  "entity",
  "entity-get",
  "entity-list",
  "entity-share",
  "entity-profile",
  "entity-import",
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
      return api(
        "/context" + query({ task: options.task, thread: options.thread }),
      );
    case "knowledge":
      return api(
        "/knowledge" + query({ q: options.query, task: options.task }),
      );
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
    case "entity-import": {
      if (options.apply !== undefined && options.apply !== true)
        throw Error("Use --apply without a value only when ready to save");
      const plan = planContactImport(JSON.parse(await readFile(need("file"), "utf8")), options.apply === true);
      const receipt = resolve(options.receipt || options.file + (options.apply ? ".import-receipt.json" : ".dry-run-receipt.json"));
      if (receipt === resolve(options.file)) throw Error("Receipt path must not replace the input file");
      const report = { importId: plan.importId, dryRun: options.apply !== true, completed: 0, batches: [], guidance: undefined, agentNotice: undefined };
      for (const batch of plan.batches) {
        try {
          const result = await sendContactBatch(body => api("/entities/import", body), batch, {
            retries: 5, onRetry: progress => process.stderr.write(JSON.stringify(progress) + "\n"),
          });
          const { guidance, agentNotice, ...saved } = result;
          report.batches.push(saved);
          report.completed += result.records.length;
          report.guidance = guidance;
          report.agentNotice = agentNotice;
          await mkdir(dirname(receipt), { recursive: true });
          const temp = receipt + "." + randomUUID() + ".tmp";
          await writeFile(temp, JSON.stringify(report, null, 2) + "\n", { mode: 0o600, flag: "wx" });
          await rename(temp, receipt);
        } catch (error) {
          error.message = `${report.completed} records completed before this batch. ` + error.message;
          throw error;
        }
      }
      return report;
    }
    case "entity-share": {
      if (!["true","false"].includes(options.revoke)) throw Error("Provide --revoke false to publish or --revoke true to revoke");
      return api("/entities/"+encodeURIComponent(need("id"))+"/share",{revoke:options.revoke==="true"});
    }
    case "entity-list":
      return api("/entities" + query({q:options.query,kind:options.kind,status:options.status,limit:options.limit||"100",cursor:options.cursor}));
    case "entity-get":
      return api("/entities/" + encodeURIComponent(need("id")));
    case "entity-profile": {
      const profile = JSON.parse(await readFile(need("file"), "utf8"));
      const current = await api("/entities/" + encodeURIComponent(need("id")));
      if (!Object.hasOwn(current, "profile")) throw Error("This website does not support structured profile saves yet. Deploy the website update first; no contact was changed.");
      return api("/entities", {
        id: need("id"),
        version: number("version"),
        profile,
      });
    }
    case "entity":
      // A Network record: a person or company the operator works with.
      return api("/entities", {
        name: need("name"),
        kind: options.kind || "person",
        ...(options.summary ? { summary: options.summary } : {}),
      });
    case "task-create":
      return api("/tasks", {
        id: need("id"),
        title: need("title"),
        room: options.room || "general",
        owner: options.owner || "",
        dependencies: options.dependencies?.split(",") || [],
        ...(options.intent ? { intent: options.intent } : {}),
        ...(options.file || options.request
          ? {
              request: options.file
                ? await readFile(options.file, "utf8")
                : options.request,
            }
          : {}),
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
