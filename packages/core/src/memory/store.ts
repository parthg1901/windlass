/**
 * The memory store: plain files a person can read, edit and delete.
 *
 *   <data dir>/memory/                        $XDG_DATA_HOME/<brand.directory>/memory, by default ~/.local/share/...
 *     user/<id>.md                            notes about the user, for every project
 *     projects/<name>-<hash>/<id>.md          notes about one project (hash of its real path)
 *     projects/<name>-<hash>/project.json     which directory that is, for a person looking
 *     usage/<session>.jsonl                   what each session was given, read, and how its turns ended
 *
 * With `inRepository` (opt-in) the project's notes are in `<project>/.<brand.directory>/memory/` instead, where they
 * can be committed and shared; user notes and usage stay in the data directory.
 *
 * One file per entry, because the things that go wrong with shared files are then impossible or small:
 * - Two harness processes. Every write takes the scope's lock (`.lock` in the scope directory: a SQLite database
 *   held with an exclusive transaction, which the operating system releases when a process dies, so it is never
 *   stale) and re-reads the scope inside it, so duplicate checks and supersession see every committed write. New
 *   files are created complete and never over an existing one (written to a temporary file, synced, then
 *   hard-linked to their name); changed files are replaced by rename. A reader sees a whole old or whole new file.
 * - A person editing while a session runs. Their editor writes one file; nothing else is touched. The store reads
 *   files when asked and keeps nothing in memory, so the edit applies from the next read. A file that no longer
 *   parses is reported (`problems`) with its path, line and what is wrong, and left exactly as it is: it is not
 *   delivered, not rewritten, not removed, and an operation on it is refused with that report.
 * - Nothing is deleted by the store. Retracted, rejected, superseded and expired entries stay on disk.
 */
import { Database, SQLiteError } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { brand } from "../brand.ts"
import { fingerprint } from "../instructions/source.ts"
import { DecodeError } from "../validate.ts"
import { type Expiry, type MemoryEntry, type MemoryKind, type MemoryScope, type Provenance, MemoryFileError, defaultExpiry, isoSeconds, parseEntryFile, renderEntryFile } from "./entry.ts"
import { type WriteCheck, byCreated, checkWrite } from "./hygiene.ts"
import { type Decision, applyDecision } from "./trust.ts"
import { type UsageRecord, usageRecord } from "./usage.ts"

export interface MemoryPaths {
  readonly root: string
  readonly user: string
  /** `null` when the session has no project (then only user notes exist). */
  readonly project: string | null
  readonly usage: string
  /** The project directory the project notes belong to, as given. */
  readonly projectDir: string | null
}

/** `$XDG_DATA_HOME/<brand.directory>`, or `~/.local/share/<brand.directory>`. */
export function defaultDataDir(env: Readonly<Record<string, string | undefined>> = process.env, home = homedir()): string {
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), brand.directory)
}

/** The directory name of a project's notes: its base name, for a person, and a hash of its real path, for uniqueness. */
export function projectKey(projectDir: string): string {
  const real = (() => {
    try {
      return realpathSync(projectDir)
    } catch {
      return resolve(projectDir)
    }
  })()
  const name = basename(real).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 40) || "project"
  return `${name}-${fingerprint(real).slice(0, 12)}`
}

export function memoryPaths(input: { readonly dataDir: string; readonly projectDir: string | null; readonly inRepository?: boolean }): MemoryPaths {
  const root = join(input.dataDir, "memory")
  const project =
    input.projectDir === null ? null : input.inRepository === true ? join(input.projectDir, `.${brand.directory}`, "memory") : join(root, "projects", projectKey(input.projectDir))
  return { root, user: join(root, "user"), project, usage: join(root, "usage"), projectDir: input.projectDir }
}

export interface MemoryProblem {
  readonly path: string
  readonly line: number | null
  readonly problem: string
}

export interface LoadedMemory {
  /** Every entry that parsed, of both scopes, oldest first. */
  readonly entries: readonly MemoryEntry[]
  readonly problems: readonly MemoryProblem[]
}

export interface NewEntry {
  readonly text: string
  readonly kind: MemoryKind
  readonly scope: MemoryScope
  readonly status: "active" | "pending"
  readonly provenance: Provenance
  /** Default: the kind's (`defaultExpiry`). */
  readonly expires?: Expiry
  readonly supersedes?: string | null
}

export type SaveResult =
  | { readonly outcome: "saved"; readonly entry: MemoryEntry; readonly path: string }
  | { readonly outcome: "merged"; readonly entry: MemoryEntry; readonly reason: string }
  | { readonly outcome: "rejected"; readonly reason: string; readonly conflict: string | null }

export type ChangeResult = { readonly ok: true; readonly entry: MemoryEntry } | { readonly ok: false; readonly reason: string }

/** The store could not do its job: the lock was held too long, or the file system failed. Not used for invalid files or refused writes. */
export class MemoryStoreError extends Error {
  constructor(
    readonly code: "locked" | "io",
    message: string,
  ) {
    super(message)
    this.name = "MemoryStoreError"
  }
}

export interface MemoryStoreOptions {
  readonly paths: MemoryPaths
  /** Default: the system clock. */
  readonly now?: () => Date
  /** Default: `m_` and 8 random hex digits. Called again when a name is taken. */
  readonly newId?: () => string
  /** How long a write waits for another process's lock, in milliseconds. Default 10 000. */
  readonly lockTimeoutMs?: number
}

export interface MemoryStore {
  readonly paths: MemoryPaths
  load(): LoadedMemory
  get(id: string): MemoryEntry | null
  /** Saves a new entry, or merges it into an existing duplicate, or refuses it (`hygiene.checkWrite`), all under the scope's lock. */
  save(entry: NewEntry): SaveResult
  retract(id: string, by: "user" | "model", reason: string | null): ChangeResult
  /** The user's decision on a pending entry. */
  decide(id: string, decision: Decision): ChangeResult
  /** The user says the entry is still true: `confirmed` becomes now, which restarts a `confirm-within` expiry (also of an expired entry). */
  renew(id: string): ChangeResult
  recordUsage(record: UsageRecord): void
  /** One session's records in the order written, or every session's. */
  usage(session?: string): { readonly records: readonly UsageRecord[]; readonly problems: readonly MemoryProblem[] }
}

export function openMemoryStore(options: MemoryStoreOptions): MemoryStore {
  const paths = options.paths
  const now = options.now ?? (() => new Date())
  const newId = options.newId ?? (() => `m_${randomBytes(4).toString("hex")}`)
  const timeout = options.lockTimeoutMs ?? 10_000
  const dirOf = (scope: MemoryScope) => {
    const dir = scope === "user" ? paths.user : paths.project
    if (dir === null) throw new MemoryStoreError("io", "this session has no project, so there is no project memory")
    return dir
  }
  const dirs = () => [paths.user, ...(paths.project === null ? [] : [paths.project])]

  const load = (): LoadedMemory => {
    const scanned = dirs().map(scan)
    return mergeScans(scanned)
  }

  /** Runs `change` on the entry under its scope's lock and writes the result. */
  const update = (id: string, change: (entry: MemoryEntry) => MemoryEntry | string): ChangeResult => {
    for (const dir of dirs()) {
      const result = withLock(dir, timeout, () => {
        const found = scan(dir)
        const problem = found.problems.find((item) => item.path === join(dir, `${id}.md`))
        if (problem !== undefined) return { ok: false as const, reason: `The file of ${id} does not parse, so it was left alone: ${describeProblem(problem)}` }
        const located = found.located.find((item) => item.entry.id === id)
        if (located === undefined) return null
        const next = change(located.entry)
        if (typeof next === "string") return { ok: false as const, reason: next }
        replaceFile(located.path, renderEntryFile(next))
        return { ok: true as const, entry: next }
      })
      if (result !== null) return result
    }
    return { ok: false, reason: `There is no memory note ${id}.` }
  }

  return {
    paths,
    load,
    get: (id) => load().entries.find((entry) => entry.id === id) ?? null,
    save: (input) => {
      const dir = dirOf(input.scope)
      return withLock(dir, timeout, () => {
        const at = now()
        // Both scopes, so a replacement that names a note of the other scope is told so; only this one is locked, and only it is written.
        const existing = load().entries
        const check: WriteCheck = checkWrite(
          { text: input.text, scope: input.scope, kind: input.kind, supersedes: input.supersedes ?? null, mayMerge: input.status === "active" },
          existing,
          at,
        )
        if (check.action === "reject") return { outcome: "rejected" as const, reason: check.reason, conflict: check.conflict }
        if (check.action === "merge") {
          const target = scan(dir).located.find((item) => item.entry.id === check.into)!
          const merged = { ...target.entry, confirmed: isoSeconds(at) }
          replaceFile(target.path, renderEntryFile(merged))
          return { outcome: "merged" as const, entry: merged, reason: check.reason }
        }
        if (dir.startsWith(join(paths.root, "projects"))) writeProjectMarker(dir, paths.projectDir)
        const stamp = isoSeconds(at)
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const entry: MemoryEntry = {
            id: newId(),
            text: input.text.trim(),
            kind: input.kind,
            scope: input.scope,
            status: input.status,
            created: stamp,
            confirmed: stamp,
            expires: input.expires ?? defaultExpiry(input.kind, input.scope),
            provenance: input.provenance,
            supersedes: input.supersedes ?? null,
            userConfirmed: null,
            retracted: null,
          }
          const path = join(dir, `${entry.id}.md`)
          if (createFile(path, renderEntryFile(entry))) return { outcome: "saved" as const, entry, path }
        }
        throw new MemoryStoreError("io", `could not find a free entry name in ${dir}`)
      })
    },
    retract: (id, by, reason) =>
      update(id, (entry) => {
        if (entry.status === "retracted") return `${id} is already retracted.`
        if (entry.status === "rejected") return `${id} was rejected by the user and is not in use.`
        return { ...entry, status: "retracted", retracted: { at: isoSeconds(now()), by, reason } }
      }),
    decide: (id, decision) =>
      update(id, (entry) => (entry.status === "pending" ? applyDecision(entry, decision, now()) : `${id} is ${entry.status}, not waiting for confirmation.`)),
    renew: (id) =>
      update(id, (entry) => (entry.status === "active" ? { ...entry, confirmed: isoSeconds(now()) } : `${id} is ${entry.status}; only an active note can be renewed.`)),
    recordUsage: (record) => {
      const valid = usageRecord(record, "record")
      mkdirSync(paths.usage, { recursive: true })
      // One write of one line with O_APPEND: a reader never sees half a record, and a session has one writer.
      appendFileSync(usageFile(paths, valid.session), `${JSON.stringify(valid)}\n`)
    },
    usage: (session) => {
      const files = session !== undefined ? [usageFile(paths, session)] : listFiles(paths.usage, ".jsonl").map((name) => join(paths.usage, name))
      const records: UsageRecord[] = []
      const problems: MemoryProblem[] = []
      for (const file of files) {
        if (!existsSync(file)) continue
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, index) => {
            if (line.trim() === "") return
            try {
              records.push(usageRecord(JSON.parse(line), ""))
            } catch (error) {
              // A torn or edited line is reported and skipped; the rest of the file still counts.
              problems.push({ path: file, line: index + 1, problem: error instanceof DecodeError || error instanceof SyntaxError ? error.message : String(error) })
            }
          })
      }
      return { records, problems }
    },
  }
}

export function describeProblem(problem: MemoryProblem): string {
  return `${problem.path}${problem.line === null ? "" : `:${problem.line}`}: ${problem.problem}`
}

function usageFile(paths: MemoryPaths, session: string) {
  return join(paths.usage, `${encodeURIComponent(session)}.jsonl`)
}

interface Scan {
  readonly located: readonly { readonly entry: MemoryEntry; readonly path: string }[]
  readonly problems: readonly MemoryProblem[]
}

/** Reads every `*.md` in a scope directory (dot-files are the store's own: the lock and temporary files). */
function scan(dir: string): Scan {
  const located: { entry: MemoryEntry; path: string }[] = []
  const problems: MemoryProblem[] = []
  for (const name of listFiles(dir, ".md")) {
    const path = join(dir, name)
    let text: string
    try {
      text = readFileSync(path, "utf8")
    } catch (error) {
      problems.push({ path, line: null, problem: `could not be read (${error instanceof Error ? error.message : String(error)})` })
      continue
    }
    try {
      located.push({ entry: parseEntryFile(text, path), path })
    } catch (error) {
      if (!(error instanceof MemoryFileError)) throw error
      problems.push({ path, line: error.line, problem: error.problem })
    }
  }
  return { located, problems }
}

function mergeScans(scans: readonly Scan[]): LoadedMemory {
  const seen = new Map<string, string>()
  const entries: MemoryEntry[] = []
  const problems: MemoryProblem[] = scans.flatMap((item) => item.problems)
  for (const { entry, path } of scans.flatMap((item) => item.located)) {
    const first = seen.get(entry.id)
    if (first !== undefined) {
      problems.push({ path, line: null, problem: `has the same id (${entry.id}) as ${first}; only that one is used` })
      continue
    }
    seen.set(entry.id, path)
    entries.push(entry)
  }
  return { entries: entries.sort(byCreated), problems: problems.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
}

function dirnameOf(path: string) {
  return path.slice(0, path.lastIndexOf("/"))
}

function listFiles(dir: string, suffix: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(suffix) && !name.startsWith("."))
      .sort()
  } catch {
    return []
  }
}

/** Creates `path` with `text`, complete, only if no file has that name. `false` when the name is taken. */
function createFile(path: string, text: string): boolean {
  const temporary = temporaryName(path)
  writeSynced(temporary, text)
  try {
    linkSync(temporary, path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw new MemoryStoreError("io", `could not create ${path}: ${(error as Error).message}`)
  } finally {
    unlinkSync(temporary)
  }
}

/** Replaces `path` with `text` in one rename, so a reader never sees a partial file. */
function replaceFile(path: string, text: string) {
  const temporary = temporaryName(path)
  writeSynced(temporary, text)
  renameSync(temporary, path)
}

function temporaryName(path: string) {
  const dir = dirnameOf(path)
  return join(dir, `.${basename(path)}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`)
}

function writeSynced(path: string, text: string) {
  const fd = openSync(path, "wx", 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function writeProjectMarker(dir: string, projectDir: string | null) {
  const marker = join(dir, "project.json")
  if (existsSync(marker)) return
  createFile(marker, `${JSON.stringify({ project: projectDir, note: `${brand.name} memory for one project; each .md file is one note and may be edited or deleted by hand.` }, null, 2)}\n`)
}

/**
 * Runs `fn` holding the scope's lock. The lock is an exclusive transaction on `<dir>/.lock`, a SQLite database
 * used only for that: another process waits up to `timeoutMs` (SQLite's busy timeout), and a process that dies
 * holding it releases it with its file descriptors. `fn` is synchronous, so within one process nothing else runs
 * while it is held.
 */
function withLock<T>(dir: string, timeoutMs: number, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new Database(join(dir, ".lock"), { create: true })
  try {
    db.run(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timeoutMs))}`)
    try {
      db.run("BEGIN EXCLUSIVE")
    } catch (error) {
      if (error instanceof SQLiteError && error.code?.startsWith("SQLITE_BUSY")) throw new MemoryStoreError("locked", `another process held the memory lock in ${dir} for more than ${timeoutMs} ms`)
      throw error
    }
    try {
      return fn()
    } finally {
      db.run("ROLLBACK")
    }
  } finally {
    db.close()
  }
}
