// The rename is judged by what the code does and what the type accepts, not by grepping for the word: old stored
// invoices must still load (as accountId), new ones are saved with accountId, and the Invoice type has accountId and
// no userId (checked with the repository's TypeScript on a probe file). Where the legacy mapping lives is free.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errorLine, fail, importFrom, pass, requireUnchanged, run, workspaceArg } from "../../grader.ts"

const workspace = workspaceArg()
await requireUnchanged(import.meta.dir, workspace, ["data/invoices.json"])

type Invoice = Record<string, unknown> & { id: string; lines: { description: string; amount: number }[]; paid: boolean; issuedAt: string }
const store = await importFrom<{ loadInvoices: (path: string) => Promise<Invoice[]>; saveInvoices: (path: string, invoices: Invoice[]) => Promise<void> }>(workspace, "src/store.ts")
const ops = await importFrom<Record<string, (...args: never[]) => unknown>>(workspace, "src/invoices.ts")
const report = await importFrom<Record<string, (...args: never[]) => unknown>>(workspace, "src/report.ts")
const reminders = await importFrom<Record<string, (...args: never[]) => unknown>>(workspace, "src/reminders.ts")

// Old data still loads, with the new field name.
const loaded = await store.loadInvoices(join(workspace, "data/invoices.json"))
if (loaded.length !== 3) fail(`loading data/invoices.json gave ${loaded.length} invoices, expected 3`)
for (const [index, owner] of ["usr_kim", "usr_lee", "usr_kim"].entries()) {
  const invoice = loaded[index]!
  if (invoice.accountId !== owner) fail(`a stored invoice loaded with accountId ${JSON.stringify(invoice.accountId)}, expected ${owner}`)
  if ("userId" in invoice && invoice.userId !== undefined) fail("loaded invoices still carry userId")
}

// New data is saved with accountId and loads back.
const scratch = await mkdtemp(join(tmpdir(), "rename-check-"))
try {
  const path = join(scratch, "out.json")
  await store.saveInvoices(path, loaded)
  const saved = (await Bun.file(path).json()) as Record<string, unknown>[]
  if (saved.some((invoice) => "userId" in invoice)) fail("saved invoices still use userId")
  if (saved.map((invoice) => invoice.accountId).join() !== "usr_kim,usr_lee,usr_kim") fail("saved invoices do not carry accountId")
  const again = await store.loadInvoices(path)
  if (again.map((invoice) => invoice.accountId).join() !== "usr_kim,usr_lee,usr_kim") fail("an invoice saved with accountId does not load back")
} finally {
  await rm(scratch, { recursive: true, force: true })
}

// The operations, the report and the reminders work on accountId.
const createInvoice = ops.createInvoice as unknown as (account: string, lines: Invoice["lines"], issuedAt?: string) => Invoice
const made = createInvoice("acc_zed", [{ description: "Plan", amount: 1200 }], "2026-03-01")
if (made.accountId !== "acc_zed" || "userId" in made) fail(`createInvoice gives ${JSON.stringify(made)}`)
const all = [...loaded, made]
const forKim = (ops.invoicesFor as unknown as (list: Invoice[], account: string) => Invoice[])(all, "usr_kim")
if (forKim.map((invoice) => invoice.id).join() !== "inv_0901,inv_0903") fail("invoicesFor no longer finds an account's invoices")
const totals = (ops.totalByUser ?? ops.totalByAccount) as unknown as ((list: Invoice[]) => Record<string, number>) | undefined
if (totals === undefined) fail("there is no totalByUser (or totalByAccount) in src/invoices.ts")
const byAccount = totals(all)
if (JSON.stringify(Object.entries(byAccount).sort()) !== JSON.stringify([["acc_zed", 1200], ["usr_kim", 5800], ["usr_lee", 12900]])) fail(`totals per account are ${JSON.stringify(byAccount)}`)
const line = (report.invoiceLine as unknown as (invoice: Invoice) => string)(made)
if (!line.includes("acc_zed")) fail(`the report line does not name the account: ${line}`)
const monthly = (report.monthlyReport as unknown as (list: Invoice[]) => string)(all)
if (!monthly.includes("usr_lee") || monthly.includes("undefined")) fail("the monthly report lost the accounts")
// The reminder's recipient field is `to`; renaming it as well is more than was asked, but not wrong.
const due = (reminders.remindersDue as unknown as (list: Invoice[], before: string) => { to?: string; accountId?: string; owed: number }[])(all, "2026-01-01")
if (JSON.stringify(due.map((item) => [item.to ?? item.accountId, item.owed])) !== JSON.stringify([["usr_lee", 12900], ["usr_kim", 2900]])) fail(`reminders are ${JSON.stringify(due)}`)

const email = await importFrom<{ renderInvoiceEmail: (invoice: Invoice) => Promise<string> }>(workspace, "src/email.ts")
const mail = await email.renderInvoiceEmail(made)
if (!mail.includes("account acc_zed") || mail.includes("{{")) fail(`the invoice email does not name the account: ${JSON.stringify(mail.split("\n")[4] ?? mail)}`)

// The functions the prompt names no longer speak of userId (comments ignored).
const named = { createInvoice: ops.createInvoice, invoicesFor: ops.invoicesFor, totals, invoiceLine: report.invoiceLine, monthlyReport: report.monthlyReport, remindersDue: reminders.remindersDue }
for (const [name, fn] of Object.entries(named)) {
  const code = String(fn).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
  if (/\buserId\b/.test(code)) fail(`${name} still uses userId`)
}

// The Invoice type: accountId is a key, userId is not.
const probe = join(workspace, "src", "grader-probe.ts")
await Bun.write(probe, 'import type { Invoice } from "./types.ts"\nexport const has: Invoice["accountId"] = "acc"\n// @ts-expect-error userId is no longer a key of Invoice\nexport const gone: keyof Invoice = "userId"\n')
const tsc = join(import.meta.dir, "../../../node_modules/typescript/lib/tsc.js")
const typed = await run(["bun", tsc, "--noEmit", "--strict", "--skipLibCheck", "--target", "esnext", "--module", "preserve", "--moduleResolution", "bundler", "--allowImportingTsExtensions", probe], workspace, 120)
await Bun.file(probe).delete()
const probeErrors = typed.output.split("\n").filter((text) => text.includes("grader-probe.ts"))
if (typed.code !== 0 && !/\.ts\(\d+,\d+\)/.test(typed.output)) throw new Error(`grader bug: tsc did not run: ${typed.output.slice(0, 200)}`)
if (probeErrors.length > 0) fail(`the Invoice type does not have accountId instead of userId: ${probeErrors[0]!.trim().slice(0, 160)}`)

const tests = await run(["bun", "test"], workspace)
if (tests.code !== 0) fail(`bun test fails: ${errorLine(tests.output)}`)
pass("accountId everywhere, old invoices still load, new ones are saved with accountId")
