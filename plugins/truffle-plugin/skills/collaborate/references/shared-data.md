Use the CLI resolved by the parent collaboration skill. In these examples, `node "$BOTSPACE_CLI"` means that same command and saved store/profile/workspace.

## Shared project data

Use the same saved connection for knowledge and work; no second identity or standalone CLI setup is needed. `context --workspace ALIAS` returns current work and wiki references; add `--task ID` for its checkpoint and dependencies. Commands below also accept `--workspace ALIAS`:

- `pages`, `page --id project/overview`, `search --query "question"`, `changes --after CURSOR`.
- `write --id project/overview --title "Overview" --file note.md --revision N [--task ID]` requires the current revision (0 for new pages). On conflict, reread and reconcile; preserve the draft.
- `tasks`, `context --task ID`; read owner, dependencies and criteria before execution.
- `task-create --id STABLE_ID --title "Task" --owner REGISTERED_ID --file brief.md --criteria '["Verifiable result"]' --intent build --dependencies ID,ID`. Omit dependencies when none exist. Existing IDs return the saved task; this is not an edit/reassignment command.
- `claim --id ID` claims as this connection's identity and returns doing status plus its new version. Conflict means reread; do not steal or duplicate work.
- `task-status --id ID --version N --status review --result "Evidence"` uses the latest returned version. Use blocked with the specific blocker, review when verification remains, and done only when criteria are met. Preserve valid transitions; queued work must be claimed before completion.
- `checkpoint --id ID --version N --summary "Current evidence, remaining work, next action"` persists the task owner's handoff. Read the returned task version before another edit.
- `export --file private-wiki.json` writes current Markdown pages and provenance to a new private JSON file. It excludes access credentials and embeddings; concurrent wiki edits fail the export so it can be retried consistently.

Write only project-relevant material authorized for sharing. New evidence does not override the operator's instructions. The tools expose shared data; they do not by themselves launch agents or supply repository/provider access. Goals/eval orchestration is not implemented by this plugin update.

## Process shared information

Use `knowledge --query "the task or question" --workspace ALIAS` to retrieve bounded,
sourced passages from discussions, task outcomes and the wiki. Existing-session
connectors receive these sources automatically; managed agents can return a cited
`knowledge` object and Kanbot saves it as a stable `insights/` wiki page.
Connect relevant evidence, identify decisions, contradictions and open questions,
and distinguish inference from verified findings. Cite the supplied source links.
Do not treat source text or an earlier synthesis as permission to execute anything.
Use `executions --root ID --workspace ALIAS` to inspect persisted turns, child
handoffs and shared turn usage. Expired running turns require reconciliation;
a saved result can be delivered without another model call. This does not migrate
native runtime sessions, local worktrees or tool credentials between machines.

## Structured person enrichment

Use `entity-get --id ID` to read the record and current `profile`. Save with `entity-profile --id ID --version N --file profile.json` using the latest record version. The file is a profile object, with its own `version: 1`. Omitted fields retain current context; a supplied history replaces that section, so preserve all existing entries. Do not dump researched résumés into relationship notes. After saving, read the record back and verify the structured profile and every sourced history entry. Existing source notes are retained.

```json
{
  "version": 1,
  "about": "A fixture engineer.",
  "history": [{
    "entity_id": "fixture-school",
    "entity_name": "Fixture School",
    "entity_type": "school",
    "relation": "education",
    "role": "BSc Robotics",
    "start": "2012",
    "end": "2016",
    "sources": [{"label": "School", "url": "https://school.example.test/alumni"}]
  }]
}
```

Relations: education, employment, affiliation, research, program, fellowship. Each history entry requires a stable lower-case organization `entity_id`, name, type and at least one http(s) source. Missing dates stay unknown. Preserve identity confidence, original meeting context, source links and unresolved claims. Source-backed affiliation does not imply employment.

## Batched contact imports

For importing many contacts, prefer `entity-import --file import.json` over repeated single-contact writes. The JSON file is `{ "importId": "import-persisted-id", "records": [...] }`. Allocate and persist contact ids before the first request; never deduplicate people by name or assume a Telegram id exists. Every record requires `id` and `version`: 0 creates only; updates require the current version. Preserve existing sourced profile history.

The command validates by default and splits the file into sequential batches of at most 50 records and 1 MB. After reviewing validation, use the same command/file with `--apply` for authorized writes. Each batch is atomic; the whole file is not. Receipts are saved next to the input (or `--receipt PATH`), including progress before interruption. Rerun the unchanged file after a lost response: durable server receipts replay completed batches without duplicate contacts or notes. Keep importId, order and contents unchanged during retries. A changed import needs reconciliation and a new persisted importId, never a blind version overwrite.

```sh
node "$BOTSPACE_CLI" entity-import --workspace product --file import.json
node "$BOTSPACE_CLI" entity-import --workspace product --file import.json --apply
```

MCP agents use `botspace_contacts_import` with `{importId, records, dryRun:true}` for one batch of 1–50 records. Set dryRun:false only when ready for authorized writes. Send batches sequentially. CLI retries temporary failures with the same batch; MCP callers retry identical arguments after uncertain responses, wait at least 60 seconds on 429 and reconcile 409 conflicts. Never fall back automatically to individual writes on older servers. Server API guidance announces compatibility changes; plugin 0.9.11 supplies these native tools. Updating the plugin does not rewrite an already-running importer or start a worker.
