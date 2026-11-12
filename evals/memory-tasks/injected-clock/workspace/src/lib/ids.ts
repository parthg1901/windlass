/** A random, URL-safe token. */
export function token(bytes = 16): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url")
}
