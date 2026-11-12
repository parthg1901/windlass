/**
 * Colours by role, never by hue. Every role maps to one of the terminal's own
 * sixteen palette colours or to its default foreground, so the theme follows
 * whatever the terminal is set to (light or dark) instead of assuming one.
 * Backgrounds are never painted, except the inverse attribute for a selection.
 *
 * With NO_COLOR (or a terminal without colour) every role keeps its
 * attributes (bold, dim, italic, inverse) and loses its colour. Nothing in the
 * TUI conveys state by colour alone: every state also has a symbol or a word.
 */
import { RGBA, TextAttributes } from "@opentui/core"

export type Role =
  | "text"
  | "dim"
  | "user"
  | "accent"
  | "ok"
  | "error"
  | "warn"
  | "info"
  | "added"
  | "removed"
  | "hunk"
  | "code"
  | "heading"
  | "mode"
  | "selected"
  | "border"
  | "cached"
  | "uncached"

export interface Span {
  readonly text: string
  readonly role?: Role
  readonly bold?: boolean
  readonly dim?: boolean
  readonly italic?: boolean
  readonly underline?: boolean
  readonly inverse?: boolean
  readonly strike?: boolean
}

export type Line = readonly Span[]

export const span = (text: string, role?: Role, style: Omit<Span, "text" | "role"> = {}): Span => ({ text, ...(role === undefined ? {} : { role }), ...style })

/** Palette index (0-15) or `null` for the default foreground, and the attributes a role always carries. */
interface RoleStyle {
  readonly color: number | null
  readonly attributes: number
}

const { BOLD, DIM, ITALIC, INVERSE, UNDERLINE, STRIKETHROUGH, NONE } = TextAttributes

const ROLES: Record<Role, RoleStyle> = {
  text: { color: null, attributes: NONE },
  dim: { color: null, attributes: DIM },
  user: { color: null, attributes: BOLD },
  accent: { color: 6, attributes: NONE },
  ok: { color: 2, attributes: NONE },
  error: { color: 1, attributes: NONE },
  warn: { color: 3, attributes: NONE },
  info: { color: 4, attributes: NONE },
  added: { color: 2, attributes: NONE },
  removed: { color: 1, attributes: NONE },
  hunk: { color: 6, attributes: DIM },
  code: { color: 5, attributes: NONE },
  heading: { color: null, attributes: BOLD | UNDERLINE },
  mode: { color: 5, attributes: BOLD },
  selected: { color: null, attributes: INVERSE },
  border: { color: null, attributes: DIM },
  cached: { color: 2, attributes: NONE },
  uncached: { color: 3, attributes: NONE },
}

export interface Paint {
  readonly fg: RGBA
  readonly attributes: number
}

export class Theme {
  private readonly cache = new Map<string, Paint>()
  private readonly defaultFg = RGBA.defaultForeground()
  readonly background = RGBA.defaultBackground()

  constructor(readonly color: boolean) {}

  /** The colour and attributes for one span. */
  paint(part: Span): Paint {
    const key = `${part.role ?? "text"}|${part.bold ? 1 : 0}${part.dim ? 1 : 0}${part.italic ? 1 : 0}${part.underline ? 1 : 0}${part.inverse ? 1 : 0}${part.strike ? 1 : 0}`
    const cached = this.cache.get(key)
    if (cached !== undefined) return cached
    const role = ROLES[part.role ?? "text"]
    let attributes = role.attributes
    if (part.bold) attributes |= BOLD
    if (part.dim) attributes |= DIM
    if (part.italic) attributes |= ITALIC
    if (part.underline) attributes |= UNDERLINE
    if (part.inverse) attributes |= INVERSE
    if (part.strike) attributes |= STRIKETHROUGH
    const fg = this.color && role.color !== null ? RGBA.fromIndex(role.color) : this.defaultFg
    const paint = { fg, attributes }
    this.cache.set(key, paint)
    return paint
  }

  /** A colour for renderables that take one (the input's text and cursor). */
  get foreground(): RGBA {
    return this.defaultFg
  }
}

/** Colour unless NO_COLOR is set to a non-empty value, as https://no-color.org asks. */
export function colorEnabled(env: Record<string, string | undefined>): boolean {
  const noColor = env.NO_COLOR
  return noColor === undefined || noColor === ""
}
