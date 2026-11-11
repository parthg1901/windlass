/**
 * Situations the blueprint requires that the current schema or reducer cannot
 * express. Each is a `test.todo`; the proposed event sequence is in
 * docs/step-loop-scenarios.md under the named gap.
 */
export const todoScenarios = [
  {
    gap: "G7",
    title: "a shutdown resume does not count toward the crash-resume cap",
  },
  {
    gap: "G8",
    title: "recovery settles an orphaned call from the effect class recorded in tool.started, not from today's registry",
  },
  {
    gap: "G9",
    title: "a crash in the middle of a user cancel finishes the cancel at next start instead of resuming the work",
  },
] as const
