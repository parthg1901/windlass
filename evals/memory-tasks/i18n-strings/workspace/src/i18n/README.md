# Translations

Every piece of text a customer sees comes from `t(key, values)` in `src/i18n/t.ts`. Add a new key to `en.json`
only; the translation service adds it to the other languages within a day, and until then `t` falls back to
English. Keys are `<page>.<what>`, lowercase, with dashes. Text written straight into the code is never translated.
