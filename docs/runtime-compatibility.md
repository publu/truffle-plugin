# Truffle runtime verification

Truffle connects Codex, Claude Code, Kimi and Hermes through one setup flow. Each runtime can receive background replies or join a managed team. The selected runtime is preserved through installation, connection and execution.

| Runtime | Installation | Background execution |
| --- | --- | --- |
| Codex | Native plugin or portable skill | Dedicated JSON CLI session |
| Claude Code | Native plugin or portable skill | Dedicated JSON CLI session |
| Kimi | Portable skill | Dedicated ACP session |
| Hermes | Portable profile skill, then `/reload-skills` | Dedicated ACP session through the bundled Hermes host |

## Hermes runtime

The bundled `hermes-runtime.mjs` locates the selected Hermes Python installation and starts `hermes-host.py`. This uses Hermes's real inference engine, configured model account and persistent ACP sessions. Session state lives in the owning Truffle connection's private state directory, separate from the operator's current conversation.

Read mode supplies project reading and search tools. Work mode adds file creation, patching and project commands. File tools enforce project paths and reject private runtime state, traversal and symlink escapes. Read mode never dispatches write or command tools. Commands run with the operator's authorized work scope and bounded time/output; work mode is not an OS filesystem sandbox. Cancellation terminates the owned runtime process group. Managed peer delegation travels through Kanbot's existing task protocol.

Portable setup preserves Hermes provider settings and credentials. Generated instructions connect and activate the same selected runtime, reuse saved project permissions and pause state, and verify real execution before reporting ready.

## Validation evidence

The checks below distinguish native package installation, actual skill discovery and completed model work so contributors can reproduce each layer. Local fixtures use isolated runtime configuration and connection stores.

## Codex native installation smoke

Installed Codex's documented local-marketplace commands were run with `CODEX_HOME` pointing to `.cache/codex-native-check` in this repository:

```sh
codex plugin marketplace add /absolute/path/to/truffle-plugin --json
codex plugin add truffle-plugin@truffle --json
codex plugin list --json
```

Marketplace registration and native installation succeeded. `plugin list` reported the local Truffle plugin installed and enabled, and the cache contained the current skill plus the managed runner scripts. No real Codex configuration or credentials were copied or changed, and no model session was started. This verifies native package installation, not authentication, runtime hook approval, or completed agent work. Source: [official OpenAI plugin packaging documentation](https://developers.openai.com/plugins/build/plugins?site_locale=en) and installed CLI help/output.

## Managed CLI regression coverage

`tests/managed.test.mjs` exercises the real Truffle CLI against a deterministic fake Kanbot binary in an isolated PATH and private store. Eleven tests cover initial startup/status, pause-preserving reconnection, explicit resume, permission-change rejection, stable task submission IDs and job lookup, invalid-setting correction, incomplete-connection recovery, private invitation handoff and cleanup, copied-home/symlink rejection, managed-only onboarding, missing components/Hermes runner registration, private uv installation destinations, and credential redaction in subprocess errors. Inherited `KANBOT_SOCK` and `KANBOT_DB` must not redirect the owned runner. These are integration contract tests, not evidence of a real model completing a task.

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

A disposable local workspace and project were connected through Truffle's managed CLI, using the Kanbot 0.9.5 candidate and the installed authenticated Codex runtime. The agent read `input.txt`, returned the sum 42, and completed the original saved onboarding mission with visible task progress. The workspace still contained exactly that one task. Retrying the stable request ID reused its job; pause followed by reconnect preserved pause and permissions; project contents remained unchanged. The owned runner and local server were stopped afterward. Evidence: `.local/managed-saved-task.log` and `.cache/managed-saved-task-601f08ff`. This verifies real managed execution for Codex. A separate authenticated Claude run through the plugin adapter also read the scratch input and returned 42 without editing it; Kimi installation/protocol checks remain recorded above.

## Real Hermes execution

The actual Hermes model read the scratch project input and returned 42 in read mode. A requested write was unavailable and no file appeared. A second process resumed the same dedicated session, recalled its codeword, wrote `answer.txt`, and ran a Python check through `project_run`; the check passed. Evidence: `.cache/hermes-real-check/read-result.json` and `work-result.json`. Additional tests cover direct dispatch denial in read mode, peer worktree reads without file-write access, nonexistent peer directories on first startup, path/symlink escapes, bounded command output/timeouts, and terminating a live command when its host is cancelled.

### Repeatable real Hermes verification

`node tests/hermes-live.mjs` is an opt-in, two-turn model test in a temporary
project. It verifies file reading/writing, a project command, the exact native
session on resume, and a resumed read-only turn. Regular `npm test` does not
launch paid models. The runtime adapter reports classified account/subscription
failures without copying raw provider errors or credentials into shared results.
