# edge-agent

This package runs unattended on customer hardware, where an uncaught exception takes the device offline until
someone drives out to it. So in this package, unlike the rest of the repository:

- Functions never throw for bad input. They return a result: `{ ok: true, value }` or `{ ok: false, error }`, where
  `error` is a short message naming the bad value. `src/result.ts` has the type and the two constructors.
- Callers handle the failure case right where they get it, usually by falling back to a default and logging.
