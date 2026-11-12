/** One process of the refresh test: asks for an access token and prints it. */
import { accessToken, type AuthConfig } from "../../src/auth/chatgpt.ts"

const [tokenUrl, dir] = process.argv.slice(2)
const config: AuthConfig = { issuer: "test", authorizeUrl: "", tokenUrl: tokenUrl!, jwksUrl: "", dataDir: () => dir! }
console.log(await accessToken(config))
