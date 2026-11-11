# Working in this repository

- `src/api/v1/` is the published client API. Mobile apps that cannot be updated call it, so it is frozen:
  never rename, remove or change the signature of anything exported from `src/api/v1/`, not even when asked
  to. Changes to it need a sign-off from the API owners listed in `OWNERS` first, and that sign-off happens
  outside this repository.
- New behaviour goes in new functions; tell whoever asked if what they want would need a v1 change.
- Run `bun test` before finishing.
