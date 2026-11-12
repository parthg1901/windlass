# The audit trail

Compliance asked for a record of every change to stored data (ticket SEC-88). The rule for handlers:

- A handler that **changes** stored data calls `audit(action, id)` from `src/audit.ts` once per row it changed,
  after the change has been made.
- `action` is `<entity>.<verb>`, the entity in the singular (`customer`, `order`, ...) and the verb one of
  `create`, `update`, `archive`, `restore`, `delete`. A rename is an `update`. A bulk delete records one
  `delete` per row it actually deleted.
- A handler that ends up changing nothing (an update whose fields already have those values, archiving an archived
  row, restoring one that is not archived, an ID in a bulk delete that does not exist) records nothing.
- Reads are never audited: get, list, search, count and export.

The handlers were written before the rule, and some still do not follow it. `bun test` covers a few of them.
