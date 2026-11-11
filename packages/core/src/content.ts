/** Content shared by user messages, synthetic messages, tool results and model requests. */
import { type Infer, array, nonEmptyString, object, literal, string, variant } from "./validate.ts"

/**
 * A reference to bytes in the content-addressed blob table (storage rule 8).
 * `hash` is the lowercase hex SHA-256 of the bytes, so the same media stored
 * twice is one row and a request block that contains the reference hashes the
 * same on every call.
 */
export const blobRef = object({ hash: nonEmptyString, mediaType: nonEmptyString })
export type BlobRef = Infer<typeof blobRef>

/** One ordered piece of message content: text, or media held in the blob table. */
export const contentPart = variant("type", {
  text: object({ type: literal("text"), text: string }),
  media: object({ type: literal("media"), blob: blobRef }),
})
export type ContentPart = Infer<typeof contentPart>

export const content = array(contentPart)
export type Content = Infer<typeof content>

/** Builds single-part text content. */
export function text(value: string): Content {
  return [{ type: "text", text: value }]
}
