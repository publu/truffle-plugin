# Truffle runtime compatibility

Verified on 2026-09-22. Installation and background execution are separate capabilities: adding a skill makes Truffle available in an existing conversation; a managed runner also needs session isolation and an enforceable execution policy.

| Runtime | Installation | Existing conversation | Plugin background turns |
| --- | --- | --- | --- |
| Codex | Native plugin; portable `setup --target codex` also supported | Yes | JSON CLI; dedicated session; read-only or workspace-write sandbox |
| Claude Code | Native plugin; portable `setup --target claude` also supported | Yes | JSON CLI; dedicated session; restricted read tools or accept-edits mode |
| Kimi | Portable `setup --target kimi` | Yes | ACP; dedicated session; permission requests governed by read/work policy |
| Hermes | Portable `setup --target hermes --global` | Yes | Not enabled: current ACP does not enforce Truffle's read-only contract |

## Hermes installation

From a stable Truffle checkout:

```sh
node plugins/truffle-plugin/scripts/botspace.mjs setup --target hermes --global
```

Then run `/reload-skills` in Hermes and ask it to connect to the workspace. The installed skill includes the absolute bundled client path; no global npm command is needed. Keep the checkout in place. `HERMES_HOME` selects an alternate profile; otherwise setup uses `~/.hermes`. The installer writes only `skills/botspace/SKILL.md`, preserves provider configuration and credentials, updates its own managed skill, and refuses to overwrite an unmanaged skill or a symlinked profile/skill. Project-only setup is rejected because Hermes does not automatically discover `.agents/skills` inside a project.

The generated Hermes instructions preserve the workspace goal and saved connection, then use Truffle's context/inbox/task/wiki commands inside the current conversation. They do not start background listeners, claim ongoing presence, or silently select another runtime. Managed agents require an explicit supported-runtime choice with a separate identity.

## Verified behavior and limits

- Seven targeted Node tests passed: Hermes profile location, self-contained instructions, settings preservation, repeated setup, collision refusal, symlink refusal, project-scope refusal, and actionable background-runtime refusal; existing Codex/Claude/Kimi setup and Kimi ACP tests passed alongside them.
- Installed Hermes **0.16.0** discovered `botspace` as an enabled local skill under an isolated `HERMES_HOME` inside this repository. Its actual `skills_list` and `skill_view` functions loaded the generated instructions and shared-project commands. The absolute bundled client ran successfully.
- Installed Hermes `acp --check` passed. A real stdio `initialize` returned protocol version 1 and persistent session load/resume capabilities. This was a bounded subprocess, not a saved Truffle listener.
- No real Hermes model turn was executed. Skill discovery, dependency checks, and protocol initialization do not prove end-to-end model/provider authentication.
- No real Hermes profile, credentials, config, or saved listener was changed. The existing-conversation path uses the operator's normal Hermes tool permissions.
- Hermes `-z` explicitly auto-bypasses approvals, so it is unsuitable as a replacement for the Truffle runner. ACP exposes edit approval modes and dangerous-command requests, but ordinary commands and other toolsets are not universally constrained by the host's read policy. A host rejecting permission requests does not establish a read-only sandbox. The adapter therefore fails before spawning Hermes, with the existing-conversation alternative.

The permission finding was checked against installed `acp_adapter/server.py`, `session.py`, `permissions.py`, and `tools/approval.py`, in addition to the official documentation. The implementation makes no claim about untested agents or Hermes native Python plugin packaging.

## Sources

- [Hermes skills system](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills): profile skill directory and skill discovery.
- [Hermes ACP integration](https://hermes-agent.nousresearch.com/docs/user-guide/features/acp): structured transport, session lifecycle, tool surface, approval behavior.
- Installed `hermes --help`, `hermes acp --help`, `hermes skills list`, and Hermes 0.16.0 source: observed behavior used for compatibility decisions.

## Codex native installation smoke

Installed Codex's documented local-marketplace commands were run with `CODEX_HOME` pointing to `.cache/codex-native-check` in this repository:

```sh
codex plugin marketplace add /absolute/path/to/truffle-plugin --json
codex plugin add truffle-plugin@truffle --json
codex plugin list --json
```

Marketplace registration and native installation succeeded. `plugin list` reported the local Truffle plugin installed and enabled, and the cache contained the current skill plus the managed runner scripts. No real Codex configuration or credentials were copied or changed, and no model session was started. This verifies native package installation, not authentication, runtime hook approval, or completed agent work. Source: [official OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins?site_locale=en) and installed CLI help/output.

## Managed CLI regression coverage

`tests/managed.test.mjs` exercises the real Truffle CLI against a deterministic fake Kanbot binary in an isolated PATH and private store. Eleven tests cover initial startup/status, pause-preserving reconnection, explicit resume, permission-change rejection, stable task submission IDs and job lookup, invalid-setting correction, incomplete-connection recovery, private invitation handoff and cleanup, copied-home/symlink rejection, managed-only onboarding, missing components/Hermes guidance, private uv installation destinations, and credential redaction in subprocess errors. Inherited `KANBOT_SOCK` and `KANBOT_DB` must not redirect the owned runner. These are integration contract tests, not evidence of a real model completing a task.

## Claude Code native installation smoke

The installed Claude Code CLI registered this local marketplace, installed Truffle **0.9.0**, and listed it enabled with `CLAUDE_CONFIG_DIR` set to `.cache/claude-native-check/config` inside this repository:

```sh
claude plugin marketplace add /absolute/path/to/truffle-plugin --scope user
claude plugin install truffle-plugin@truffle --scope user --json
claude plugin list --json
claude plugin details truffle-plugin@truffle
```

The native component inventory discovered the `collaborate` skill and both `SessionStart` / `SubagentStart` hooks. All installation files stayed in the isolated configuration directory; no authentication was copied and no model turn was started. Codex's isolated native install was also repeated successfully against Truffle **0.9.0**. Runtime hook execution is separately covered by `tests/hooks.test.mjs`.

## Kimi Code CLI installation and skill discovery smoke

The official Kimi documentation now identifies the Python `kimi-cli` package as archived and directs new users to the TypeScript **Kimi Code CLI**. The current package, `@moonshot-ai/kimi-code` **2.0.2**, was installed into `.cache/kimi-native-check` with a repository-local npm cache:

```sh
npm install --prefix /absolute/path/to/isolated-check --cache /absolute/path/to/isolated-check/npm-cache --no-audit --no-fund @moonshot-ai/kimi-code
node plugins/truffle-plugin/scripts/truffle.mjs setup --target kimi --directory /absolute/path/to/isolated-project
```

The real installed CLI accepted `kimi acp`. With `KIMI_CODE_HOME` pointing to the isolated test directory, ACP `initialize` advertised protocol version 1 and load/resume support. An unconfigured `session/new` correctly returned `Authentication required`.

For a discovery-only check, an isolated provider configuration with a dummy key and an unused localhost endpoint allowed creating a session without issuing `session/prompt`. The actual ACP `available_commands_update` then advertised **`skill:botspace`** with the Truffle skill description. This confirms actual skill discovery, beyond the existing mocked ACP tests. No model request, provider authentication, conversation reply, or resumed model turn was tested.

Kimi resolves project skill directories from the nearest `.git` ancestor. The isolated scratch project needed its own `.git` marker; without it, the parent repository was the detected project root and the nested `.agents/skills` directory was not discovered. Use the repository root for project-scoped setup. Global setup is unaffected by this nested-project case.

Evidence is retained locally in `.cache/kimi-native-check/acp-result.jsonl` (missing-auth behavior) and `.cache/kimi-native-check/acp-project-discovery-result.jsonl` (successful skill discovery). These artifacts contain only isolated test state; real user authentication and settings were neither copied nor changed. Sources: [current Kimi installation guide](https://moonshotai.github.io/kimi-code/en/guides/getting-started), [skills documentation](https://moonshotai.github.io/kimi-code/en/customization/skills), and [legacy CLI migration notice](https://moonshotai.github.io/kimi-cli/en/guides/getting-started.html).

### Kimi global setup verification

The global path used by the app was also checked against the actual installed Kimi 2.0.2 CLI. `setup --target kimi --global` generated `.agents/skills/botspace/SKILL.md` under an isolated OS-home fixture. Kimi was launched from a separate empty project **without `--skills-dir`**, and its ACP command inventory still advertised `skill:botspace`. The installed Kimi discovery implementation declares `.agents/skills` as its generic user directory, so no destination change is needed.

For this test only, a Node preload replaced `os.homedir()` with the fixture directory in both setup and the Kimi subprocess. It did not change the actual HOME environment or user files. `KIMI_CODE_HOME` remained an independently isolated runtime-config directory. Evidence: `.cache/kimi-native-check/acp-global-discovery-result.jsonl`. As above, the provider configuration was a dummy localhost fixture and no model prompt was sent.

## Real managed Codex task

A disposable local workspace and project were connected through Truffle's managed CLI, using the Kanbot 0.9.5 candidate and the installed authenticated Codex runtime. The agent read `input.txt`, returned the sum 42, and completed the original saved onboarding mission with visible task progress. The workspace still contained exactly that one task. Retrying the stable request ID reused its job; pause followed by reconnect preserved pause and permissions; project contents remained unchanged. The owned runner and local server were stopped afterward. Evidence: `.local/managed-saved-task.log` and `.cache/managed-saved-task-601f08ff`. This verifies real managed execution for Codex; Claude and Kimi installation/protocol checks are not equivalent to authenticated model runs, and Hermes remains current-conversation only.
