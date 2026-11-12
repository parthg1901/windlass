# Repository conventions

- TypeScript, run with Bun. `bun test` from the root runs every package's tests.
- Invalid input is an error: throw a `RangeError` (or `TypeError` for the wrong type) with a message that names the
  bad value. Callers decide what to do with it.
- Keep helpers next to their one caller; there is no shared utils package on purpose.
