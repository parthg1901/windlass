# Replay

Run the real model again against a changed prompt or changed harness code, and answer every tool call that
matches the recording from the recording. While the model makes the same calls the replay has no side
effects; the first call it makes differently is the finding.

| File | What |
| --- | --- |
| `tape.ts` | `tapeFromStore` / `tapeFromEvents`: steps, calls with their exact settlements, inputs with positions |
| `match.ts` | `TapeMatcher`: the matching rules (doc comment at the top), divergence kinds, `normalise.*` |
| `replay.ts` | `createReplay`: the cursor plus `executor`, a `ToolRuntime` with the `stop` / `execute-read-only` / `execute` policies |
| `report.ts` | `buildReport`, `renderReport` (text), `renderReportJson` |
| `effects.ts` | After a replay: `compareEffects` (side effects, reads ignored), `lenientWalk` (how far a matcher that lets reads pass would get, and where answering a read from the tape would be unsound), `compareReplay` (both, plus the final files), `readOnlyCommand` (the shell allowlist) |
| `driver.ts` | `runReplay`: a loop-free reference driver for tests; the step loop replaces it |
| `fake.ts` | `responsesFromTape`: fake-provider scripts that reproduce a tape |

## What the step loop needs to run a real replay

1. Start a new session (a fork at seq 0 or a fresh one) whose baseline is the changed prompt and tools.
2. Before each step, append `replay.takeInputs()` as the messages they are (user and harness messages,
   instructions, settings). Stop when `replay.status` is no longer `on_tape` / `off_tape`.
3. Give the loop `replay.executor` instead of the real tool runtime, and pass a step's calls to `runAll`
   together, after the response finished. `onStart` is called exactly when the recorded call started, so the
   loop writes the same `tool.started` / `tool.settled` it always writes.
4. After the step's terminal event, call `replay.endStep({ text, calls, usage })`. `action: "stop"` ends the
   execution; `interrupted: "user"` means the recorded step was cut by the user here, so close it as interrupted.
5. Wire `onStop` to the execution's abort if a stop must also cancel calls still running off tape.
6. For `execute` policies, restore a throwaway copy of the workspace at the recorded state (the snapshot track)
   and run the replay inside the sandbox; the executor refuses an override that overlaps the original.

## What a replay run should record (for the event-schema owner to decide)

- That the session is a replay: of which session, through which `seq`, with which policy and match options.
- Per call: matched (recorded step and call, exact or normalised), dropped by a recorded interrupt, diverged
  (kind and the recorded side), or executed off tape.
- Why the replay ended: identical, diverged, unsupported (compaction, revert, refusal) or incomplete.

## A live lenient matcher (not built: it needs the engine)

`effects.ts` applies the lenient rules (L1, L2 in its doc comment) after an `execute` replay has finished, which
needs nothing from the engine and gives the same answer a live mode would, because every read off the recording was
really run in a copy at the recorded state. A live mode that also works under `stop` needs, in the spine:

1. `ReplayRequest.matching?: "strict" | "lenient"` (default `strict`), passed to `createReplay`, and recorded in
   `lineage` of `session.created` (the validators are strict, so this is a schema change in `event/durable.ts`).
2. A matcher that keeps the tape cursor on acts only and answers looks by `lenientWalk`'s rule, and two new
   `replay.call` results: `served` (answered from another recorded step, with its position) and `looked` (run for
   real). Both are new values of the `result` enum in `event/durable.ts`, and the reducer and request builder are
   unchanged (they are tool results like any other).
3. For `looked` under `execute`, a copy at the recorded state *at that point*, not at the divergence: the copy
   must follow the tape, either by running matched acts in it too, or by restoring the `step_end` snapshot of the
   last matched act's step before each real look.
4. Independently of lenient matching: the step in which a replay leaves the tape is not bracketed by snapshots
   (`tracked` is decided in `engine.ts` while `onTape()` is still true), so a replay's log can miss that step's
   changes. The suite works around it by snapshotting the copy after the replay (`snapshotOfCopy` in
   `scripts/replay.ts`). The fix: take a `step_end` snapshot when `director.live` turned true during the step's tools.
