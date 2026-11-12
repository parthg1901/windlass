/**
 * The real engine behind the CLI's `Engine` interface: a thin adapter. The
 * harness itself (the data directory, a store per session, the ChatGPT-plan
 * provider with the saved sign-in, the standard tools, the defaults) is put
 * together by `createHarness` in `@windlass/core`, which the ACP server
 * uses too. What is added here is the CLI's own: an `OpenRequest` becomes a
 * session, and everything that can be missing in a user's environment (no
 * sign-in, a session another process is working in, an unknown session or
 * model) becomes `EngineUnavailable` with a sentence the CLI prints.
 *
 * `createRealEngine()` does nothing until `open` (or a listing) is called:
 * the CLI creates it for every run that is not a demo, including runs that
 * only print help. One CLI process works in one session, so closing that
 * session closes the harness; other processes carry on in theirs.
 */
import {
  type ChoiceId,
  currentTodos,
  describeRestrictions,
  EngineError,
  type EngineSession,
  type Harness,
  type HarnessOptions,
  ModelListError,
  StoreError,
  brand,
  createHarness,
  restrictionTag,
} from "@windlass/core"
import { titleFromEvents } from "@windlass/acp/extensions"
import { isUndone, turnsOf } from "@windlass/acp/turns"
import { askLocally } from "./commands.ts"
import { type Approver, type Engine, EngineUnavailable, type ModelInfo, type OpenRequest, type Session, type SessionSummary, signInSentence } from "./engine.ts"

export { DEFAULT_EFFORT, DEFAULT_MODEL } from "@windlass/core"

/** For tests and scripts. The CLI passes nothing. */
export type RealEngineOptions = HarnessOptions

export function createRealEngine(options: RealEngineOptions = {}): Engine {
  const harness = createHarness(options)

  return {
    open: async (request): Promise<Session> => {
      if (harness.closed) throw new EngineUnavailable("the engine is closed")
      const signIn = await harness.signIn()
      if (!signIn.signedIn) throw new EngineUnavailable(signInSentence(signIn.message), "auth")
      const session = await unavailable(() => sessionFor(harness, request))
      // The user's own choices for this run, and whether anyone is at the terminal to answer.
      session.setAttended(request.attended ?? false)
      if (request.approval != null || request.unattended != null)
        session.setApproval({ ...(request.approval == null ? {} : { mode: request.approval }), ...(request.unattended == null ? {} : { unattended: request.unattended }) })
      let approver: Approver | null = null
      // A question is durable before it is put: it is answered by the approver, and declined when there is none.
      session.subscribe((item) => {
        if (item.type !== "approval.requested") return
        const target = { messageId: item.data.messageId, callId: item.data.callId }
        const answer = (reply: { readonly choice: ChoiceId; readonly note?: string } | null) => {
          try {
            // Backing out of the question stops the turn, which withdraws it.
            if (reply === null) session.interrupt()
            else session.answer(target, reply)
          } catch {
            // The session was closed in the meantime.
          }
        }
        if (approver === null) return answer({ choice: "deny" })
        void approver({ ...target, question: item.data.question }).then(answer, () => answer({ choice: "deny" }))
      })
      return {
        id: session.id,
        events: session.events,
        send: async (value, send = {}) =>
          session.send(value, {
            ...(send.delivery === undefined ? {} : { delivery: send.delivery }),
            ...(request.maxSteps === null ? {} : { maxSteps: request.maxSteps }),
          }),
        interrupt: () => session.interrupt(),
        revert: (revert = {}) => askLocally(session.revert, revert),
        undoRevert: (undo = {}) => askLocally(session.undoRevert, undo),
        setApprover: (next) => {
          approver = next
        },
        clearTaint: async () => session.clearTaint(),
        approvalMode: async (mode) => {
          if (mode !== undefined) session.setApproval({ mode: mode as "ask" | "auto" | "full" })
          const state = session.approval()
          return { mode: state?.policy.mode ?? null, tainted: state?.taint.tainted ?? false, taint: session.projection().session.approval?.taint?.text ?? null }
        },
        agents: async () => {
          const listing = session.agents()
          if (listing === null) return { available: false, agents: [], problems: [], default: null, ignored: [], current: null }
          return {
            available: true,
            agents: listing.agents.map((agent) => ({ name: agent.name, description: agent.description, path: agent.path, scope: agent.root.scope, model: agent.model, effort: agent.effort, restrictions: describeRestrictions(agent.restrictions), tag: restrictionTag(agent.restrictions) })),
            problems: listing.problems,
            default: listing.default,
            ignored: [...listing.ignored],
            current: session.agent()?.name ?? null,
          }
        },
        setAgent: async (name) => void (await unavailable(async () => session.setAgent(name))),
        rename: async (title) => unavailable(async () => session.rename(title)),
        compact: () => session.compact(),
        describe: async () => {
          const events = harness.engine.readEvents(session.id)
          const turns = turnsOf(events)
          const projection = session.projection()
          return {
            title: projection.session.title ?? titleFromEvents(events),
            turns: turns.length,
            undone: turns.filter(isUndone).length,
            events,
            agent: session.agent()?.name ?? null,
            model: projection.session.settings.model,
            effort: projection.session.settings.reasoningEffort,
            tasks: currentTodos(projection.messages)?.items ?? null,
          }
        },
        close: () => harness.close(),
      }
    },

    listSessions: async ({ cwd }): Promise<SessionSummary[]> => {
      try {
        return await unavailable(async () =>
          harness.engine.listSessions({ cwd }).map((summary) => ({
            id: summary.session.id,
            // As the protocol path lists it: the session's own title, or one derived from its first message.
            title: summary.session.title ?? titleFromEvents(harness.engine.readEvents(summary.session.id, { limit: 60 })),
            cwd: summary.session.cwd,
            updatedAt: summary.updatedAt,
            model: summary.session.settings.model,
          })),
        )
      } finally {
        await harness.close()
      }
    },

    listModels: async (): Promise<ModelInfo[]> => {
      try {
        const models = await harness.listModels()
        return models.map((model) => ({
          id: model.id,
          description: model.name === model.id ? null : model.name,
          efforts: model.efforts,
          isDefault: model.id === harness.defaults.model,
        }))
      } catch (error) {
        if (error instanceof ModelListError)
          throw error.error.kind === "auth"
            ? new EngineUnavailable(signInSentence(error.message, "the models cannot be listed (they come from your ChatGPT plan)"), "auth")
            : new EngineUnavailable(`could not list the models: ${error.message}`)
        throw error
      }
    },
  }
}

/** The session a request names: a new one, the one an ID or a unique prefix of one names, or the latest in the directory. */
async function sessionFor(harness: Harness, request: OpenRequest): Promise<EngineSession> {
  const engine = harness.engine
  const asked = { model: request.model, effort: request.effort }
  // A model or an effort named on the command line is checked before a session is created with it or switched to it.
  if (request.model !== null || (request.effort !== null && request.session.kind === "new")) await engine.validateSettings(await harness.settingsFor(request.cwd, asked))
  const target = request.session
  const agent = request.agent ?? null
  if (target.kind === "new") return engine.createSession({ cwd: request.cwd, settings: await harness.settingsFor(request.cwd, asked), ...(agent === null ? {} : { agent }) })
  const id = target.kind === "resume" ? engine.resolveSession(target.id) : engine.latestSession(request.cwd)?.session.id
  if (id === undefined) throw new EngineUnavailable(`there is no session to continue in ${request.cwd}`)
  // A claim left by a process that died or shut down is repaired here. It is worked on again once the user says
  // something, so that what they say is in front of the model in the first step after the restart.
  const session = engine.openSession(id, { resume: "wait" })
  const current = session.projection().session.settings
  if (request.model !== null || request.effort !== null)
    session.setSettings({ model: request.model ?? current.model, reasoningEffort: request.effort ?? current.reasoningEffort })
  // `--agent` with a session that exists switches it, as `/agent` would.
  if (agent !== null) session.setAgent(agent)
  return session
}

/** Says what is missing in the user's environment as a sentence, instead of a stack trace. */
async function unavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // Each of these messages is written for the user: which session, who holds it and what to do, or which models exist.
    if (error instanceof EngineError && error.code !== "closed")
      // A session the command line named that does not exist is as wrong as an unknown model (`-c` with nothing to continue says so on its own).
      throw new EngineUnavailable(error.message, error.code === "unknown_model" || error.code === "unknown_effort" || error.code === "ambiguous_session" || error.code === "session_not_found" || error.code === "invalid_request" ? "usage" : null)
    if (error instanceof StoreError && error.code === "schema_mismatch")
      throw new EngineUnavailable(`that session was written by another version of ${brand.name} and cannot be opened by this one (${error.message})`)
    throw error
  }
}
