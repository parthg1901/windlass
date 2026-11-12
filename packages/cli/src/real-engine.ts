/**
 * The real engine behind the CLI's `Engine` interface: a thin adapter. The
 * harness itself (the data directory, a store per session, the ChatGPT-plan
 * provider with the saved sign-in, the standard tools, the defaults) is put
 * together by `createHarness` in `@light-harness/core`, which the ACP server
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
  EngineError,
  type EngineSession,
  type Harness,
  type HarnessOptions,
  ModelListError,
  StoreError,
  brand,
  createHarness,
} from "@light-harness/core"
import { askLocally } from "./commands.ts"
import { type Approver, type Engine, EngineUnavailable, type ModelInfo, type OpenRequest, SIGN_IN_ADVICE, type Session, type SessionSummary } from "./engine.ts"

export { DEFAULT_EFFORT, DEFAULT_MODEL } from "@light-harness/core"

/** For tests and scripts. The CLI passes nothing. */
export type RealEngineOptions = HarnessOptions

const SIGN_IN = SIGN_IN_ADVICE

export function createRealEngine(options: RealEngineOptions = {}): Engine {
  const harness = createHarness(options)

  return {
    open: async (request): Promise<Session> => {
      if (harness.closed) throw new EngineUnavailable("the engine is closed")
      const signIn = await harness.signIn()
      if (!signIn.signedIn) throw new EngineUnavailable(`${signIn.message} (${SIGN_IN})`)
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
        close: () => harness.close(),
      }
    },

    listSessions: async ({ cwd }): Promise<SessionSummary[]> => {
      try {
        return await unavailable(async () =>
          harness.engine.listSessions({ cwd }).map((summary) => ({
            id: summary.session.id,
            title: summary.session.title,
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
          throw new EngineUnavailable(`could not list the models: ${error.error.kind === "auth" ? `${error.message} (${SIGN_IN})` : error.message}`)
        throw error
      }
    },
  }
}

/** The session a request names: a new one, the one an ID or a unique prefix of one names, or the latest in the directory. */
async function sessionFor(harness: Harness, request: OpenRequest): Promise<EngineSession> {
  const engine = harness.engine
  const asked = { model: request.model, effort: request.effort }
  // A model named on the command line is checked before a session is created with it or switched to it.
  if (request.model !== null) await engine.validateSettings(await harness.settingsFor(request.cwd, asked))
  const target = request.session
  if (target.kind === "new") return engine.createSession({ cwd: request.cwd, settings: await harness.settingsFor(request.cwd, asked) })
  const id = target.kind === "resume" ? engine.resolveSession(target.id) : engine.latestSession(request.cwd)?.session.id
  if (id === undefined) throw new EngineUnavailable(`there is no session to continue in ${request.cwd}`)
  // A claim left by a process that died or shut down is repaired here. It is worked on again once the user says
  // something, so that what they say is in front of the model in the first step after the restart.
  const session = engine.openSession(id, { resume: "wait" })
  const current = session.projection().session.settings
  if (request.model !== null || request.effort !== null)
    session.setSettings({ model: request.model ?? current.model, reasoningEffort: request.effort ?? current.reasoningEffort })
  return session
}

/** Says what is missing in the user's environment as a sentence, instead of a stack trace. */
async function unavailable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // Each of these messages is written for the user: which session, who holds it and what to do, or which models exist.
    if (error instanceof EngineError && error.code !== "closed") throw new EngineUnavailable(error.message)
    if (error instanceof StoreError && error.code === "schema_mismatch")
      throw new EngineUnavailable(`that session was written by another version of ${brand.name} and cannot be opened by this one (${error.message})`)
    throw error
  }
}
