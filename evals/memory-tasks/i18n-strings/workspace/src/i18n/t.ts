import de from "./de.json"
import en from "./en.json"

const LANGUAGES: Record<string, Record<string, string>> = { en, de }
let language = "en"

export function setLanguage(code: string): void {
  if (!(code in LANGUAGES)) throw new Error(`no translations for ${code}`)
  language = code
}

/** The text for `key` in the current language (English when it is not translated yet), with `{name}` filled in. */
export function t(key: string, values: Record<string, string | number> = {}): string {
  const template = LANGUAGES[language]![key] ?? (en as Record<string, string>)[key]
  if (template === undefined) throw new Error(`no text for ${key}`)
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
}
