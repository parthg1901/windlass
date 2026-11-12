# @acme/listkit

Small helpers for lists in UIs: pagination, grouping, stable sorting.

```ts
import { paginate } from "@acme/listkit"
paginate(rows, 2, 25) // { items, page: 2, pages }
```

`bun test` runs the tests; `bun run release` cuts a release (maintainers only).
