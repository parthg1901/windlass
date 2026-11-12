# Contributing

- `bun test` must pass before you push.
- Time: read it with `now()` from `src/clock.ts`, never `Date.now()` or `new Date()`. Tests move the clock with
  `setNow()`; anything that reads the system clock directly cannot be tested and will be sent back in review.
- Errors a user can cause are `Error`s with a message a person can read; the API layer turns them into 4xx.
