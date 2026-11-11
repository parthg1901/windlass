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
