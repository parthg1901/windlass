/**
 * Tool approval: when a call runs freely, runs in the sandbox, asks the user,
 * or is denied, and how untrusted content tightens that. Pure functions and
 * types; the integration does every lookup and every write. See README.md.
 */
export {
  DEFAULT_APPROVAL,
  type ApprovalMode,
  type ApprovalPolicy,
  type ApprovalSection,
  type ResolvedApproval,
  type TaintEnforcement,
  type UnattendedAction,
  approvalMode,
  approvalModes,
  approvalSection,
  modeRank,
  resolveApprovalConfig,
} from "./policy.ts"
export { MAX_LINKS, type PathContext, type PathFact, type PathPlace, type Readlink, isWithin, lexicalPath, pathFact, protectedRoots, realPath } from "./paths.ts"
export {
  PROJECT_GRANT_TTL_MS,
  type Grant,
  type GrantRule,
  type GrantScope,
  type GrantTemplate,
  type Need,
  applies,
  grant,
  grantRule,
  isCovered,
  isOutbound,
  rememberableScopes,
  stampGrants,
} from "./grants.ts"
export { CLEAN, type HistoryEntry, type TaintSource, type TaintSourceKind, type TaintState, deriveTaint, describeTaint } from "./taint.ts"
export {
  MAX_ESCALATION_PATHS,
  type Escalation,
  type EscalationRequest,
  type SandboxHint,
  type SandboxRun,
  escalationFacts,
  escalationRequest,
  escalationSchema,
  sandboxHint,
} from "./escalation.ts"
export { type CallFacts, type Choice, type Decision, type DecisionInput, type Question, type RunDecision, type SandboxState, decide } from "./decide.ts"
export { MIN_SECRET_LENGTH, type Redaction, type RedactionKind, redact, redactionKinds } from "./redact.ts"
export { approvedNote, declinedMessage, deniedMessage, describeNeed, unattendedMessage } from "./texts.ts"
