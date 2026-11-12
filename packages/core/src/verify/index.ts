/**
 * Verification: the harness runs the project's checks after the agent changed
 * files and hands the result to the model as a fact. The step loop owns when;
 * this module owns which checks, how they run, what the model is shown, whether
 * the turn may end, and the evidence that it ended on something.
 */
export { ACKNOWLEDGE_TOOL_NAME, type Acknowledgement, acknowledgeTool, acknowledgement } from "./acknowledge.ts"
export { type CheckEvidence, type VerificationEvidence, buildEvidence, checkEvidence, verificationEvidence } from "./evidence.ts"
export { fingerprintCheck, reusablePass } from "./fingerprint.ts"
export { type GateDecision, type GateInput, type UnresolvedReason, decideGate } from "./gate.ts"
export { type ReportedCheck, renderOutput, renderReport } from "./report.ts"
export { type CheckOutput, type CheckResult, type CheckStatus, type RunCheckOptions, checkStatus, isFailure, runCheck, runChecks } from "./run.ts"
export { filesFor, selectChecks } from "./select.ts"
