import { json } from "../http.ts"

export default function handleUsers() {
  return json([{ id: 1, name: "Ada" }])
}
