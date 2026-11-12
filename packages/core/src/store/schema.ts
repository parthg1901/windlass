/**
 * The SQLite schema. DDL only; the storage track runs it.
 *
 * `event` is the source of truth. `session`, `message` and `inbox` are
 * projections of it, written only by `Store.append` in the same transaction
 * as the event. `request` is the request ledger; it sits beside the log and
 * is never sent to the model as rows. Media is not in the database: it lives
 * in the blob store that sessions share (`blobs.ts`).
 *
 * The harness keeps one such database per session (`directory.ts`). Nothing
 * in the schema depends on that: the tables are keyed by session, and a file
 * that holds several sessions (a test, a tool) works the same.
 */

/**
 * Stored in `PRAGMA user_version`. Bump it with every change to `SCHEMA_SQL`,
 * and, until the first release, with every change to the shape of the JSON
 * the rows hold (an event's data, `SessionState`, a message): a file written
 * before the change is then refused as `schema_mismatch` instead of failing
 * to decode halfway through a read.
 *
 * 2: snapshots, verification and revert (new events, `execution.succeeded`
 *    and `history.reverted` data, workspace and verification state in `SessionState`).
 * 3: one database per session: media left for the shared blob store (no `blob`
 *    table); `turn.ended`, check results that are carried over, the directories a
 *    session has worked in.
 * 4: compaction with a checkpoint: `compaction.started` carries the cut, the
 *    prompt and the size, `compaction.repair_requested` is new, and a
 *    compaction message holds them. (The history tools' full-text index is
 *    not part of this schema: it is derived data in tables `history-index.ts`
 *    creates when a session is first searched.)
 * 5: `message.changed_seq`, so that reading a session's state reads the
 *    message rows an append changed and not every row there is. With it the
 *    shapes that changed since version 4: a fork's `session.created` carries
 *    the taint entries of its inherited history, a subagent's ending says
 *    `left_to_parent`, a compaction's ending says how many summary calls it
 *    took, and an approval can be about a tool that changes only the
 *    harness's own records.
 * 6: the request ledger says which provider served a call (`provider`) and
 *    what the provider wrote to its cache (`cache_write_tokens` and the
 *    12-hour part of it); `Usage`, and so `step.ended`, carry the same counts.
 * 7: hooks and language-server diagnostics: `hook.ran` is new, `tool.settled`
 *    may carry `diagnostics`, a turn's ending may name stop hooks that were
 *    not satisfied, and the taint history a fork carries may hold a hook's
 *    output or a language server's note.
 * 8: slash commands and what a trace needs of a model call: `command.expanded`
 *    is new, an inbox item and a user message may carry the command that
 *    produced them, and the request ledger keeps the provider's own ID of a
 *    request and the model that answered (`provider_request_id`, `response_model`).
 * 9: one tool call stopped by the user, and watches on a background command's
 *    output: `tool.cancel_requested`, `watch.started`, `watch.fired` and
 *    `watch.ended` are new, a tool call may carry the request to stop it
 *    (`cancel`), and a running background command the watches set on it.
 * 10: the record of a restore (`history.reverted`, `history.restored`) says
 *    how many files it wrote and how many it removed (`written`, `removed`),
 *    and a watch may end because its regular expression was too slow on a
 *    line (`watch.ended` with the reason `too_slow`).
 * 11: the record of a slash command (`command.expanded`, and with it an inbox
 *    item and a user message) says which typed arguments the template had no
 *    place for (`unused`).
 */
export const SCHEMA_VERSION = 11

/**
 * Run on every connection, before anything else.
 * - WAL: readers do not block the single writer.
 * - `synchronous = FULL`: a committed append survives power loss, which
 *   "the tool call is durable before the tool runs" needs.
 * - Foreign keys are off by default in SQLite.
 */
export const CONNECTION_PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = FULL",
  "PRAGMA foreign_keys = ON",
] as const

/** Run once on an empty database, then set `PRAGMA user_version = SCHEMA_VERSION`. */
export const SCHEMA_SQL = `
-- One row per session. Lineage is in typed columns, not inside JSON.
CREATE TABLE session (
  id               TEXT PRIMARY KEY,
  -- Lineage. All three are NULL for a root session. For a fork, the session's
  -- history is the parent's events 1..parent_seq followed by its own. The
  -- parent is usually in another file, so this is not a foreign key.
  parent_id        TEXT,
  parent_kind      TEXT,
  parent_seq       INTEGER,
  cwd              TEXT NOT NULL,
  title            TEXT,
  archived         INTEGER NOT NULL DEFAULT 0,
  -- The crash-recovery claim, copied out of state so startup can find claimed sessions.
  execution_id     TEXT,
  execution_status TEXT,
  -- seq of the last appended event. The next event gets last_seq + 1.
  last_seq         INTEGER NOT NULL,
  time_created     INTEGER NOT NULL,
  time_updated     INTEGER NOT NULL,
  -- JSON of SessionState, the reducer's session state.
  state            TEXT NOT NULL,
  -- JSON of Baseline (frozen instructions and tool list), NULL before the first baseline.set.
  baseline         TEXT,
  CHECK ((parent_id IS NULL) = (parent_kind IS NULL)),
  CHECK ((parent_id IS NULL) = (parent_seq IS NULL)),
  CHECK ((execution_id IS NULL) = (execution_status IS NULL))
) STRICT;

CREATE INDEX session_listing ON session (archived, time_updated);
CREATE INDEX session_claimed ON session (execution_status) WHERE execution_id IS NOT NULL;
CREATE INDEX session_parent ON session (parent_id) WHERE parent_id IS NOT NULL;

-- The append-only log. (session_id, seq) is dense per session and is the only order.
-- A fork's rows start at parent_seq + 1; its inherited events are read from the parent (in this
-- file or, through the session directory, in the parent's own), not copied.
CREATE TABLE event (
  session_id TEXT NOT NULL REFERENCES session (id),
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  v          INTEGER NOT NULL,
  time       INTEGER NOT NULL,
  -- Canonical JSON of the event's data.
  data       TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_no_update BEFORE UPDATE ON event
BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;

CREATE TRIGGER event_no_delete BEFORE DELETE ON event
BEGIN SELECT RAISE(ABORT, 'the event log is append-only'); END;

-- Projection: one row per message, ordered by the seq of the event that created it.
-- A fork gets its own copies of the inherited message rows when it is created.
-- Rows are updated in place as a message changes and are never deleted;
-- revert and refusal set "excluded", compaction is a marker in session.state.
CREATE TABLE message (
  session_id TEXT NOT NULL REFERENCES session (id),
  seq        INTEGER NOT NULL,
  id         TEXT NOT NULL,
  -- user | synthetic | instruction | assistant | compaction
  kind       TEXT NOT NULL,
  -- NULL, or why the message is left out of model history: reverted | refused
  excluded   TEXT,
  -- The session's last_seq as of the append that last wrote this row (for a fork's inherited rows, its first
  -- event). A reader that holds the state as of seq N brings it up to date from the rows with changed_seq > N.
  changed_seq INTEGER NOT NULL,
  -- JSON of the Message.
  data       TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
) STRICT, WITHOUT ROWID;

CREATE UNIQUE INDEX message_id ON message (session_id, id);
CREATE INDEX message_changed ON message (session_id, changed_seq);

-- Projection: admitted input that has not been delivered. A row is removed
-- when its item is delivered or cancelled; the log keeps the history.
CREATE TABLE inbox (
  session_id TEXT NOT NULL REFERENCES session (id),
  message_id TEXT NOT NULL,
  -- seq of the enqueue event: the delivery order within a delivery mode.
  seq        INTEGER NOT NULL,
  -- steer | queue
  delivery   TEXT NOT NULL,
  -- JSON of the InboxItem.
  data       TEXT NOT NULL,
  PRIMARY KEY (session_id, message_id)
) STRICT, WITHOUT ROWID;

-- The request ledger: one row per model call, written before the call is sent
-- and completed when it ends.
CREATE TABLE request (
  ordinal             INTEGER PRIMARY KEY AUTOINCREMENT,
  id                  TEXT NOT NULL UNIQUE,
  session_id          TEXT NOT NULL REFERENCES session (id),
  -- The assistant or compaction message the call serves.
  message_id          TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  -- step | compaction
  purpose             TEXT NOT NULL,
  model               TEXT NOT NULL,
  -- The provider that served the call, by its own name (Provider.id).
  provider            TEXT NOT NULL,
  -- JSON array of {kind, hash, bytes}: the ordered block hashes of the request.
  blocks              TEXT NOT NULL,
  time_started        INTEGER NOT NULL,
  time_finished       INTEGER,
  -- NULL while in flight; then ok | error | aborted
  outcome             TEXT,
  error_kind          TEXT,
  input_tokens        INTEGER,
  cached_input_tokens INTEGER,
  output_tokens       INTEGER,
  reasoning_tokens    INTEGER,
  -- What the provider says it wrote to its prompt cache, and the part of that with the 12-hour lifetime.
  -- NULL when the provider reported no such figure (which is not the same as zero).
  cache_write_tokens     INTEGER,
  cache_write_12h_tokens INTEGER,
  -- What the response said about itself, when it did: the provider's own ID of the request, and the model that answered.
  provider_request_id    TEXT,
  response_model         TEXT
) STRICT;

CREATE INDEX request_session ON request (session_id, ordinal);
`
