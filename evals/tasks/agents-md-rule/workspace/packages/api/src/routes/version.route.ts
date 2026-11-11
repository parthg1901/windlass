import { json } from "../http.ts"

export default function handleVersion() {
  return json({ version: "0.4.1" })
}
