// Developer sign-in helper for ChatGPT plan usage.
//
//   bun scripts/login.ts start            print the sign-in URL (and save the pending state)
//   bun scripts/login.ts listen           wait on the loopback port for the browser callback
//   bun scripts/login.ts finish <file>    finish from a file holding the pasted callback URL
//   bun scripts/login.ts status           show who is signed in (never prints tokens)
//   bun scripts/login.ts ping [model]     list models and make one small request
//
// On a remote machine the browser's redirect to 127.0.0.1 lands on the user's own
// computer, so the page fails to load there. The address bar still holds the full
// callback URL: paste it into a file and run `finish`.

import {
  AuthError,
  RESOURCE,
  accessToken,
  beginLogin,
  credentialsPath,
  finishLogin,
  loadCredentials,
  loadPending,
} from "../packages/core/src/auth/chatgpt.ts"

const [command, argument] = process.argv.slice(2)

async function main() {
  if (command === "start") {
    const { url } = await beginLogin()
    console.log(url)
    return
  }
  if (command === "listen") {
    const pending = await loadPending()
    if (!pending) throw new AuthError("no_pending_login", "Run `start` first.")
    const port = Number(new URL(pending.redirectUri).port)
    await new Promise<void>((resolve, reject) => {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname !== "/auth/callback") return new Response("Not found", { status: 404 })
          try {
            const credentials = await finishLogin(request.url, pending)
            console.log(`signed in as ${credentials.account.email ?? credentials.account.sub}`)
            setTimeout(() => (server.stop(), resolve()), 100)
            return new Response("Signed in. You can close this window.")
          } catch (error) {
            setTimeout(() => (server.stop(), reject(error)), 100)
            return new Response("Sign-in failed. Check the terminal.", { status: 400 })
          }
        },
      })
      console.error(`waiting for the browser callback on ${pending.redirectUri}`)
    })
    return
  }
  if (command === "finish") {
    if (!argument) throw new AuthError("usage", "Usage: finish <file-with-callback-url>")
    const credentials = await finishLogin(await Bun.file(argument).text())
    console.log(`signed in as ${credentials.account.email ?? credentials.account.sub}`)
    return
  }
  if (command === "status") {
    const credentials = await loadCredentials()
    if (!credentials) return console.log("signed out")
    console.log(
      JSON.stringify(
        {
          account: credentials.account.email ?? credentials.account.sub,
          clientId: credentials.clientId,
          scopes: credentials.scopes,
          accessTokenExpiresInMinutes: Math.round((credentials.expiresAt - Date.now()) / 60000),
          file: credentialsPath(),
        },
        null,
        2,
      ),
    )
    return
  }
  if (command === "ping") {
    const token = await accessToken()
    const listed = await fetch(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${token}` } })
    if (!listed.ok) throw new AuthError(`http_${listed.status}`, (await listed.text()).slice(0, 500))
    const catalog = (await listed.json()) as { models?: Array<{ slug: string; visibility?: string }> }
    const slugs = (catalog.models ?? []).filter((model) => model.visibility === "list").map((model) => model.slug)
    console.log(`models: ${slugs.join(", ")}`)
    const model = argument ?? slugs[0]
    if (!model) throw new AuthError("no_models", "No models are available for this account.")
    const response = await fetch(`${RESOURCE}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        input: [{ role: "user", content: "Say exactly: Hello, world!" }],
        store: false,
        stream: true,
      }),
    })
    if (!response.ok || !response.body)
      throw new AuthError(`http_${response.status}`, (await response.text()).slice(0, 500))
    const types = new Map<string, number>()
    let text = ""
    let usage: unknown
    let buffer = ""
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      buffer += chunk
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (!data || data === "[DONE]") continue
        const event = JSON.parse(data) as { type: string; delta?: string; response?: { usage?: unknown } }
        types.set(event.type, (types.get(event.type) ?? 0) + 1)
        if (event.type === "response.output_text.delta") text += event.delta ?? ""
        if (event.type === "response.completed") usage = event.response?.usage
      }
    }
    console.log(`model: ${model}`)
    console.log(`text: ${text}`)
    console.log(`usage: ${JSON.stringify(usage)}`)
    console.log(`events: ${[...types].map(([type, count]) => `${type}×${count}`).join(", ")}`)
    return
  }
  console.error("Usage: bun scripts/login.ts start | listen | finish <file> | status | ping [model]")
  process.exit(2)
}

main().catch((error) => {
  console.error(error instanceof AuthError ? `${error.code}: ${error.message}` : error)
  process.exit(1)
})
