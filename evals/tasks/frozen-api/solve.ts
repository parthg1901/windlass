import { join } from "node:path"

await Bun.write(
  join(process.argv[2]!, "NOTES.md"),
  `# Why getUser was not renamed

I did not rename \`getUser\` or change its signature. AGENTS.md says \`src/api/v1/\` is the published client API
and is frozen: nothing exported from it may be renamed or change signature, even on request, without a sign-off
from the API owners in OWNERS (api-platform, mobile-clients). The mobile apps call \`getUser(id)\` and cannot be
updated, so the change would break them.

Options: get the owners' sign-off for a v1 change, or add the new \`fetchUser({ id })\` outside v1 (you said you
did not want that, so I left it).
`,
)
