/**
 * A command that succeeded and only printed a file gets the note that tells the model to ask for the network,
 * when the file merely quotes a failed name lookup.
 *
 * Promise. docs/safety.md, "How the agent gets more access": "A command whose failure a pipeline or `|| true` hid
 * ... gets the note too when its output shows a failed name lookup as curl, git, wget, npm, Node, Bun or Python
 * report it; text that merely mentions DNS or an error code does not count." packages/core/src/approval/escalation.ts
 * (`NETWORK_REFUSALS`): "only these shapes, which source code or a log that merely mentions DNS does not have".
 *
 * What happens. For an exit code of 0 the whole output is searched for `NETWORK_REFUSALS`, a pattern with no
 * anchor to the start of a line and no tie to what the command ran. A source comment, a README's troubleshooting
 * line, or a saved CI log that quotes the client's message, printed by `cat`, `sed -n` or `git show`, matches, and
 * the result ends with "[sandbox] ... its output shows that a network request failed, although it exited 0 ...
 * run it again with `sandbox: { "network": true }`; the user will be asked." The note grants nothing (the user is
 * still asked), so the harm is a misleading prompt to ask for network access; but the content that triggers it is
 * workspace content anyone can write, and the note puts the request in the model's mind.
 *
 * Code path. packages/core/src/approval/escalation.ts `sandboxHint`:
 * `const network = !run.network && (failed ? NETWORK_MARKERS.test(run.output) : NETWORK_REFUSALS.test(run.output))`.
 *
 * Smallest fix. For a command that exited 0, require the refusal at the start of a line as the clients print it
 * (`^curl: \(6\) Could not resolve host: ...`, `^fatal: unable to access ...: Could not resolve host`,
 * `^npm (ERR!|error) ... getaddrinfo ENOTFOUND`, Python's `[Errno -3] Temporary failure in name resolution` at the
 * end of a traceback line) instead of anywhere in a line, so a comment or a sentence that quotes it does not count.
 *
 * What else the fix affects. The existing positive cases in packages/core/test/approval/escalation.test.ts (real
 * client output under bubblewrap) must keep matching; a client that prefixes its message differently would lose
 * the note, which only costs a hint.
 */
import { expect, test } from "bun:test"
import { sandboxHint } from "../../src/approval/escalation.ts"

const printed = (output: string) => sandboxHint({ sandboxed: true, network: false, exitCode: 0, output })

test.failing("a source file whose comment quotes a failed lookup, printed by a command that succeeded, gets no note", () => {
  const source = ["// The client retries when the network is down.", "// Offline it fails with: getaddrinfo ENOTFOUND registry.example.com", "export const retries = 3", ""].join("\n")
  expect(printed(source)).toBeNull()
})

test.failing("a README's troubleshooting sentence that quotes curl's message gets no note", () => {
  const readme = ["## Troubleshooting", "", "If the install script stops with Could not resolve host: downloads.example.com, check your proxy settings.", ""].join("\n")
  expect(printed(readme)).toBeNull()
})

test("control: a sentence that only mentions DNS or an error code gets no note today", () => {
  expect(printed("The DNS lookup fails with ENOTFOUND when the host is unknown.\n")).toBeNull()
})
