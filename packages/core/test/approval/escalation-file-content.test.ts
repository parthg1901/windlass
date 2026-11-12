/**
 * For a command that exited 0, the note that tells the model it could ask for the network is added only when the
 * output shows a failed name lookup where and as a client prints it: at the start of a line, with the client's own
 * prefix. A source comment, a README sentence or a string that quotes such a message, printed by `cat`, `sed -n` or
 * `git show`, does not count (docs/safety.md, "How the agent gets more access"). The client outputs below were
 * taken under bubblewrap with no network, host names replaced by example ones.
 */
import { describe, expect, test } from "bun:test"
import { sandboxHint } from "../../src/approval/escalation.ts"

const printed = (output: string) => sandboxHint({ sandboxed: true, network: false, exitCode: 0, output })

test("a source file whose comment quotes a failed lookup, printed by a command that succeeded, gets no note", () => {
  const source = ["// The client retries when the network is down.", "// Offline it fails with: getaddrinfo ENOTFOUND registry.example.com", "export const retries = 3", ""].join("\n")
  expect(printed(source)).toBeNull()
})

test("a README's troubleshooting sentence that quotes curl's message gets no note", () => {
  const readme = ["## Troubleshooting", "", "If the install script stops with Could not resolve host: downloads.example.com, check your proxy settings.", ""].join("\n")
  expect(printed(readme)).toBeNull()
})

test("control: a sentence that only mentions DNS or an error code gets no note", () => {
  expect(printed("The DNS lookup fails with ENOTFOUND when the host is unknown.\n")).toBeNull()
})

describe("text that quotes a client's message is not the client's message", () => {
  for (const output of [
    // Quoted inside a line: comments, strings, prose, a log line with a timestamp in front.
    "# socket.gaierror: [Errno -3] Temporary failure in name resolution",
    "    raise RuntimeError('urllib.error.URLError: <urlopen error [Errno -3] Temporary failure in name resolution>')",
    'const message = "Error: getaddrinfo ENOTFOUND registry.example.com"',
    "> curl: (6) Could not resolve host: example.com",
    "2026-11-12T09:00:00Z fatal: unable to access 'https://example.com/r.git/': Could not resolve host: example.com",
    "- `npm error request to https://registry.npmjs.org/x failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org`",
    "Note: wget: unable to resolve host address ‘example.com’ means the proxy is not set.",
    "When ssh says Could not resolve hostname example.com: Temporary failure in name resolution, check /etc/hosts.",
    "Run it again if you see error: DNSResolveFailed downloading package manifest x.",
    // Indented, as a Markdown code block or a nested list quotes it.
    "    curl: (6) Could not resolve host: example.com",
    "  Error: getaddrinfo EAI_AGAIN example.com",
  ])
    test(output, () => expect(printed(`Some text.\n${output}\nMore text.\n`)).toBeNull())
})

describe("what the clients print still gets the note when the exit code was hidden", () => {
  for (const output of [
    // curl without -s: the error follows the progress meter on the same line, after a carriage return.
    "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n                                 Dload  Upload   Total   Spent    Left  Speed\n\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0curl: (6) Could not resolve host: example.com\n",
    // Node's fetch: the lookup is the cause, indented.
    "TypeError: fetch failed\n    at Object.processResponse (node:internal/deps/undici/undici:13033:20) {\n  [cause]: Error: getaddrinfo EAI_AGAIN example.com\n      at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:122:26) {\n",
    // Node's https.get, after its stack header.
    "node:events:505\n    throw er; // Unhandled 'error' event\n    ^\n\nError: getaddrinfo EAI_AGAIN example.com\n    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:122:26)\n",
    // npm prints several lines; the one with the host counts.
    "npm error code EAI_AGAIN\nnpm error syscall getaddrinfo\nnpm error errno EAI_AGAIN\nnpm error request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org\n",
    "npm ERR! request to https://registry.npmjs.org/left-pad failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n",
    // Python: socket and requests.
    'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nsocket.gaierror: [Errno -3] Temporary failure in name resolution\n',
    "requests.exceptions.ConnectionError: HTTPSConnectionPool(host='example.com', port=443): Max retries exceeded with url: / (Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object at 0x7f00>: Failed to resolve 'example.com' ([Errno -3] Temporary failure in name resolution)\"))\n",
    // ssh ends its line with a carriage return; wget prints two lines.
    "ssh: Could not resolve hostname example.com: Temporary failure in name resolution\r\n",
    "--2026-11-12 11:36:37--  https://example.com/\nResolving example.com (example.com)... failed: Temporary failure in name resolution.\nwget: unable to resolve host address ‘example.com’\n",
  ])
    test(JSON.stringify(output.slice(0, 60)), () => {
      const hint = printed(output)
      expect(hint?.suspects).toEqual(["network"])
      expect(hint?.note).toContain("although it exited 0")
    })
})

test("the limit: a file line that is exactly what a client prints counts, so printing a saved log of it gets the note", () => {
  // It costs only a hint: the user is still asked before any network is given.
  expect(printed("```\ncurl: (6) Could not resolve host: example.com\n```\n")?.suspects).toEqual(["network"])
})

test("a command that failed is still looked at for any sign of the network, wherever it is", () => {
  expect(sandboxHint({ sandboxed: true, network: false, exitCode: 1, output: "warning: retrying; reason: getaddrinfo ENOTFOUND registry.example.com" })?.suspects).toEqual(["network"])
})
