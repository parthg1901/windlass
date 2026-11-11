# API package rules

- Every route lives in its own file, `src/routes/<name>.route.ts`, and default-exports a function named
  `handle<Name>`, for example `src/routes/users.route.ts` exports `export default function handleUsers()`.
- Register every route in `src/routes/index.ts`. Keep that list sorted alphabetically by path.
- Build every response with `json()` from `src/http.ts`. Never construct a `Response` directly in a route.
