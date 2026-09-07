# Observational memory: Michiel's fork

A Pi extension that compresses conversation chunks into observations, then promotes older observations into topic files. Based on [amosblomqvist/pi-observational-memory](https://github.com/amosblomqvist/pi-observational-memory), commit `78a1efc`.

This fork prioritizes predictable source coverage and explicit completion. The upstream `PLAN.md` is historical design context, not the current contract.

## Install

Requires a working Pi installation with `pi` on PATH, Git, Node.js/npm, and SSH access to this private GitHub repository:

```bash
pi install git:git@github.com:michielpapenhove/pi-observational-memory.git
```

In Pi, run `/reload`, then `/om on` in a new session. Remove or disable any other installation of observational-memory first so the extension loads only once. See [Adoption](#adoption) when switching from upstream.

Worker models use the `observational-memory` namespace in `~/.pi/agent/settings.json`. For example, merge this section into your settings to use DeepSeek:

```json
{
  "observational-memory": {
    "models": {
      "observer": { "provider": "deepseek", "id": "deepseek-v4-flash", "thinking": "high" },
      "consolidator": { "provider": "deepseek", "id": "deepseek-v4-flash", "thinking": "high" }
    }
  }
}
```

Configure provider credentials locally in Pi; they are not part of this repository. Conversation chunks are sent to the configured worker providers, so choose providers permitted for your work data. Without overrides, the workers use the OpenRouter defaults listed below.

To update later, stop OM and let workers exit, then run:

```bash
pi update --extension git:git@github.com:michielpapenhove/pi-observational-memory.git
```

Run `/reload` and `/om on` afterward. Updating this fork does not require discarding its existing sessions or memories.

## Pipeline

1. One observer at a time reads a source chunk. Its final `record_observations` call must set `complete:true`, including for zero-observation chunks.
2. Only a normal worker ending with a valid run-bound receipt advances the branch-local ledger. A failed chunk remains next in line; later chunks cannot jump over it.
3. One consolidator may run alongside the observer. It folds the oldest observations into flat topic files.
4. Its final `complete_consolidation` call accounts for **every** supplied observation with a topic filename or explicit discard reason. Existing facts can reference an unchanged topic; needless rewrites are not required.
5. A rejected consolidator confirmation lists missing, unknown and duplicate IDs. The worker may resubmit a full corrected array, with up to three correction opportunities. These precisely tracked validation errors do not invalidate a subsequently accepted confirmation. Other tool errors stop the worker immediately. The worker extension writes a success receipt only after a normal final model stop without unrecovered model/tool failures. The master checks the receipt identity, all dispositions, referenced topic metadata/body and content hashes before removing the batch from the buffer.
6. Compaction uses only confirmed chunk boundaries. Without one, it cancels rather than replacing unobserved history with an empty summary. With observer backlog, it can retain a larger raw tail than requested.

Receipts verify bookkeeping and file bytes, **not semantic completeness**. A model can still summarize poorly or wrongly classify a fact as noise. This is not a lossless database.

## Storage and path rules

```
<project>/.memory/<immutable-session-id>/
  INDEX.md          # master-generated, project-relative links
  JOURNEY.md        # short descriptive history
  auth.md           # flat topic, required front-matter
  user-profile.md
  .runs/            # per-run request, completion, activity and cost files
```

The master sees project-relative paths such as `.memory/<id>/auth.md`. Worker tools see **only bare filenames** such as `auth.md`. The worker prompt renders its own root-relative index. Directories, absolute paths, hidden files, `.memory/` prefixes, and symlink files/root are rejected. `grep` is literal text search, not regex. Files are limited to 512 KiB; oversized reads fail explicitly instead of silently truncating them.

Topic files require `id` (matching the filename stem), `title`, `summary`, `updated`, and a nonempty body. Filenames are lowercase kebab-case with `.md`. `INDEX.md` cannot be edited by the worker; `JOURNEY.md` has no front-matter and cannot stand in for a topic in a completion receipt.

Writes use a unique temporary file plus rename, with owner-only file permissions. This is **atomic per file, not a multi-file transaction**. A failed run may have updated some topics; the source observations stay available for retry. Failed workers write a failure receipt with the cause, never an acknowledgement. Missing receipts produce a readable incomplete-run error rather than a raw ENOENT. There is no journal, migration framework or automatic duplicate-tree merge. Files are session-scoped but intentionally not rolled back by `/tree`.

## Session-start memory intro

`before_agent_start` injects **one** persisted message (`om.memory-intro`, visible in the TUI) when om is enabled and the session has durable memory: the memory map rendered inline (same renderer as compaction) plus pointers to `JOURNEY.md` and the topic files, and an instruction to read them before re-deriving or re-asking known context. The memory map otherwise only appears in the compaction block, leaving fresh forks (or sessions that never reach the compaction threshold) blind to their own seeded memory. When there is nothing durable yet (no topics, no journey), nothing is injected.

Self-gating, no leakage: the per-session `/om` gate (`runtime.enabled`/`memoryRoot`), `OM_WORKER` (observer/consolidator subprocesses), and the `.runs/memory-intro` marker for exactly-once. The marker lives in the transient `.runs/` tree, which fork seeding skips, so a fork always receives its own intro even though it seeded the parent's files; it also survives resume/reload. To revert, remove the `registerMemoryInjectHook` line in `src/index.ts` and the hook file.

## Commands

- `/om`, `/om on`, `/om off`: session-local gate, default off.
- `/om:status`: coverage, pool, attempts, memory root, costs and last error.
- `/om:compact`: request compaction.
- `/om:consolidate`: manual consolidation, bypassing threshold/backoff/attempt limit, but not an active run.

The footer retains O/C/X gauges and cost. Running worker widgets show elapsed time, successful write/edit operations, last tool and age of that activity. Elapsed time is not proof of progress; “awaiting activity” can mean the model is thinking or waiting on its provider.

## Failure and lifecycle rules

- Deadline: 15 minutes by default, then SIGTERM and SIGKILL after a three-second grace if the process has not exited.
- stderr retains only the last 16 KiB.
- Prompts use stdin, still recorded as real Pi user messages. No large transcript in argv.
- Input exceeding `maxWorkerPromptBytes` blocks that role with an explicit `/om:status` reason and one UI notice. It does not consume retries or advance coverage. Nothing is silently truncated. Increase the limit only if the configured model has room, then `/reload`, or leave OM off for that session. A manual consolidator retry can recheck a changed batch/file.
- Retries occur on a later `agent_start`/`turn_end`, after exponential backoff. There is no idle retry daemon. After three consecutive failures the role stops automatically retrying. `/om off` then `/om on` resets attempts; `/om:consolidate` also allows a manual consolidator retry.
- Off, navigation, session replacement and shutdown invalidate asynchronous callbacks. Ordinary new turns do not. Aborted workers retain their occupied slots until process close, so a quick off/on cannot overlap two consolidators writing the same files.
- Run cost files are best-effort, including partial runs. Late results from a replaced runtime are not appended to the new session; their cost evidence remains in `.runs/`.
- Background workers are ordinary recorded Pi sessions, with no tools outside their dedicated tool belt. No worker receives the main session's skills, extensions or context files.

The sandbox assumes a trusted local project/root and no hostile concurrent filesystem replacement. It prevents model-selected traversal and existing symlinks; it is not an OS security boundary against another local process.

## Settings

Namespace `observational-memory` in global or project Pi settings:

| Setting | Default |
|---|---:|
| `chunkTokens` | 10000 |
| `poolTargetTokens` | 10000 |
| `consolidateAtPoolTokens` | 15000 |
| `compactAtContextTokens` | 150000 |
| `tailTokens` | 20000 |
| `journeyTargetTokens` | 1000 |
| `workerTimeoutMs` | 900000 |
| `maxWorkerPromptBytes` | 262144 |
| `maxWorkerAttempts` | 3 |
| `retryDelayMs` | 5000 |
| `resumeAfterMidRunCompaction` | true |
| `passive` | false |
| `debugLog` | false |

`models.observer` and `models.consolidator` retain their provider/id/thinking configuration. Defaults are `openrouter/z-ai/glm-5.3` with low/medium thinking. `PI_OM_PASSIVE=1` disables automatic work. The legacy `observerConcurrency` setting is ignored: this fork uses one observer. `chunkOverlapTokens` is legacy and does not implement overlap.

When `debugLog` is enabled, worker start/confirmed/failed/blocked records go to `~/.pi/agent/observational-memory/debug/<session-id>.ndjson`, rotated at 10 MiB. Logs contain run IDs and counts, not prompts. Full worker conversation recordings stay in Pi's session store. IPC files are currently retained; there is no automatic cleanup policy.

## Development

```
npm ci --ignore-scripts
npm test
npm run typecheck
```

Tests use temporary directories, mocked model workers and real dummy Node processes for deadline/stdin tests. They make no model calls and do not alter the installed extension, user sessions or project memories. Regression coverage includes path/index agreement, symlinks, strict receipts, malformed output, retry coverage, zero-observation completion, late callbacks, unsafe compaction, input limits and TERM/KILL escalation.

## Adoption

Do not replace code underneath running workers. Stop OM in active sessions and let workers exit before installing/reloading the fork.

When switching from upstream, start with **new Pi sessions and empty OM memory**. Old OM ledgers may contain invalid coverage and old topic trees can be duplicated; this fork does not repair or certify them. Existing ordinary Pi conversation logs need not be deleted. Removing old `.memory/` files while resuming an old OM-enabled session is unsafe: its ledger may already have dropped observations in favor of those files. No automatic migration or deletion is performed.
