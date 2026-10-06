import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9-]{2,79}$/);
const labels = z.array(z.string().trim().min(1).max(80)).max(20);
export const contactImportRecord = z.object({
  id, version: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(["person", "company", "organization", "project"]).optional(),
  status: z.enum(["active", "potential", "archived"]).optional(),
  summary: z.string().max(2000).optional(),
  role: z.string().max(160).optional(), company: z.string().max(160).optional(),
  email: z.string().max(240).optional(), phone: z.string().max(80).optional(),
  handle: z.string().max(160).optional(),
  tags: labels.optional(), topics: labels.optional(),
  links: z.array(z.string().url().refine(v => /^https?:\/\//i.test(v), "Use HTTP(S) links")).max(20).optional(),
  note: z.string().max(5000).optional(), source: z.string().max(300).optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
}).strict();
export const contactImportShape = {
  importId: id.describe("Persist this batch id before sending; reuse with identical records to retry."),
  dryRun: z.boolean().default(true).describe("Defaults to validation only. Set false only for an authorized import."),
  records: z.array(contactImportRecord).min(1).max(50),
};
const batchSchema = z.object(contactImportShape).strict();
const bytes = value => Buffer.byteLength(JSON.stringify(value));

export function validateContactBatch(value) {
  const batch = batchSchema.parse(value);
  if (new Set(batch.records.map(r => r.id)).size !== batch.records.length)
    throw Error("Duplicate contact ids in batch");
  if (bytes(batch) > 1000000) throw Error("Contact batch exceeds 1 MB; use smaller batches");
  return batch;
}

// Plan the entire file before sending anything. Batch ids and boundaries stay
// fixed across dry-run/apply/restart; edited records conflict instead of silently
// becoming a fresh import. The server owns durable receipts and version checks.
export function planContactImport(value, apply = false) {
  const input = z.object({ importId: id, records: z.array(contactImportRecord).min(1) }).strict().parse(value);
  if (new Set(input.records.map(r => r.id)).size !== input.records.length)
    throw Error("Duplicate contact ids in import file");
  const batches = [];
  let offset = 0;
  while (offset < input.records.length) {
    const batch = {
      importId: "import-" + createHash("sha256").update(input.importId + ":" + offset).digest("hex"),
      dryRun: !apply, records: [],
    };
    for (const record of input.records.slice(offset, offset + 50)) {
      batch.records.push(record);
      if (bytes({ ...batch, dryRun: false }) > 1000000) { batch.records.pop(); break; }
    }
    if (!batch.records.length) throw Error(`Contact at offset ${offset} exceeds the 1 MB request limit`);
    batches.push(validateContactBatch(batch));
    offset += batch.records.length;
  }
  return { importId: input.importId, batches };
}

export async function sendContactBatch(api, value, { retries = 0, onRetry = () => {} } = {}) {
  const batch = validateContactBatch(value);
  try {
    let result;
    for (let attempt = 0; ; attempt++) {
      try { result = await api(batch); break; }
      catch (error) {
        if (attempt >= retries || (error.status && ![429, 502, 503, 504].includes(error.status))) throw error;
        const waitMs = error.status === 429 ? 60000 : Math.min(30000, 2000 * 2 ** attempt);
        onRetry({ importId: batch.importId, retry: attempt + 1, waitSeconds: waitMs / 1000 });
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    if (result?.importId !== batch.importId || (result?.dryRun === true) !== batch.dryRun ||
        !Array.isArray(result.records) || result.records.length !== batch.records.length ||
        result.records.some((r, i) => r.id !== batch.records[i].id || !Number.isSafeInteger(r.version)))
      throw Error("Server returned an incomplete or unrecognized import receipt");
    return result;
  } catch (error) {
    error.message += ` Batch ${batch.importId}: preserve the file and ids. After 429 wait at least 60 seconds; after 503 or an uncertain response retry the identical batch. On 409 read current versions and reconcile before using a new import id. Never fall back to individual writes automatically.`;
    throw error;
  }
}
