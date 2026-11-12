# Contributing

## Development

    bun install
    bun test

Keep pull requests small and give them a title that says what changes for users of the library.

## Code style

- TypeScript, no default exports.
- Public functions have a doc comment with an example when the behaviour is not obvious.
- No runtime dependencies.

## Releases

Maintainers cut releases with `bun run release`. The script assembles CHANGELOG.md from the fragments in `.changes/`
(one file per change, named `<issue>.<type>.md`, where the type is feature, fix, docs or removal) and deletes the
fragments. CHANGELOG.md is never edited by hand: whatever is written there directly is lost at the next release.
