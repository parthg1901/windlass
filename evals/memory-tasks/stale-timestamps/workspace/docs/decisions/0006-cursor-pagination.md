# 6. Cursor pagination

Accepted, 2026-08-14.

List endpoints return `{ items, next }`, where `next` is an opaque cursor or `null`. Offsets are not accepted: the
lists change while a driver scrolls.
