/**
 * Light Markdown for assistant text: fenced code blocks, inline code,
 * emphasis, headings, lists and quotes. Each source line becomes one logical
 * line (with the hanging indent its wrapped rows take), so a streaming reply
 * only ever grows at its end: nothing above the last line reflows as more
 * text arrives. An unclosed fence is code until the end, which is what it is
 * while it streams.
 */
import { type Span, span } from "./theme.ts"

export interface MdLine {
  readonly spans: Span[]
  /** What the wrapped rows after the first start with. */
  readonly indent: Span[]
  /** Code is cut rather than wrapped at word boundaries: it is wrapped by character. */
  readonly code: boolean
}

/** `plain`: no colour to show inline code by, so its backticks stay. */
export function markdown(text: string, plain = false): MdLine[] {
  const out: MdLine[] = []
  let fence: string | null = null
  for (const raw of text.split("\n")) {
    const opening = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/.exec(raw)
    if (fence !== null) {
      if (opening !== null && opening[2]!.startsWith(fence) && opening[3] === "") {
        fence = null
        continue
      }
      out.push({ spans: [span("│ ", "border"), span(raw, "code")], indent: [span("│ ", "border")], code: true })
      continue
    }
    if (opening !== null) {
      fence = opening[2]!
      if (opening[3] !== "") out.push({ spans: [span(`╭ ${opening[3]}`, "border")], indent: [], code: true })
      continue
    }
    out.push(block(raw, plain))
  }
  return out
}

function block(raw: string, plain: boolean): MdLine {
  const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw)
  if (heading !== null) return { spans: inline(heading[2]!, { role: "heading" }, plain), indent: [], code: false }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) return { spans: [span("────────", "border")], indent: [], code: false }
  const quote = /^\s*>\s?(.*)$/.exec(raw)
  if (quote !== null) return { spans: [span("│ ", "border"), ...inline(quote[1]!, { italic: true, dim: true }, plain)], indent: [span("│ ", "border")], code: false }
  const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(raw)
  if (item !== null) {
    const lead = " ".repeat(Math.min(item[1]!.length, 8))
    const bullet = /\d/.test(item[2]!) ? `${item[2]} ` : "• "
    const box = item[3] === undefined ? "" : item[3].includes(" ]") ? "☐ " : "☑ "
    return { spans: [span(lead), span(bullet, "accent"), span(box), ...inline(item[4]!, {}, plain)], indent: [span(lead + " ".repeat(Bun.stringWidth(bullet + box)))], code: false }
  }
  const lead = /^\s*/.exec(raw)![0]
  return { spans: inline(raw, {}, plain), indent: lead === "" ? [] : [span(lead)], code: false }
}

/** Inline code, bold, italic and links. Unbalanced markers are left as typed. */
export function inline(text: string, base: Omit<Span, "text"> = {}, plain = false): Span[] {
  const out: Span[] = []
  const pattern = /(`+)([^`]+?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|(?<![\w*])\*(?![\s*])([^*]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_]+?)(?<!\s)_(?![\w_])|\[([^\]]+)\]\(([^)\s]+)\)/g
  let last = 0
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) out.push({ ...base, text: text.slice(last, match.index) })
    if (match[2] !== undefined) out.push({ ...base, text: plain ? match[0] : match[2], role: "code" })
    else if (match[3] !== undefined || match[4] !== undefined) out.push({ ...base, text: (match[3] ?? match[4])!, bold: true })
    else if (match[5] !== undefined || match[6] !== undefined) out.push({ ...base, text: (match[5] ?? match[6])!, italic: true })
    else if (match[7] !== undefined) {
      out.push({ ...base, text: match[7], underline: true })
      if (match[8] !== match[7]) out.push({ ...base, text: ` (${match[8]})`, dim: true })
    }
    last = match.index + match[0].length
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) })
  return out
}
