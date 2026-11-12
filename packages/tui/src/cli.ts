/**
 * What the TUI takes from the line-based CLI, in one place: its engine types,
 * its per-tool summaries and its scripted demo engine. The CLI package exports
 * only its entry point and engine interface, so these are imported by path;
 * the TUI reuses the CLI's judgement of what a tool call or a check is worth
 * saying rather than keeping a second copy of it.
 */
export type { Engine, EngineEvent, ModelInfo, OpenRequest, SendOptions, Session, SessionSummary } from "../../cli/src/engine.ts"
export { turnOutcomeOf, EXIT_UNRESOLVED, exitCodeOf } from "../../cli/src/engine.ts"
export { callArgument, checkLines, checksSummary, detailLines, diffStat, errorSummary, fileList, firstLine, successSummary, unresolvedReason } from "../../cli/src/tools.ts"
export { formatDuration, formatBytes, nearest } from "../../cli/src/text.ts"
export { changeLabel, handEditChoices } from "../../cli/src/commands.ts"
export { usageText } from "../../cli/src/renderer.ts"
export { FakeEngine, type FakeOptions, type FakeSession } from "../../cli/src/fake-engine.ts"
export { type DemoScenario, demoScenarios, findScenario } from "../../cli/src/demo/scenarios.ts"
