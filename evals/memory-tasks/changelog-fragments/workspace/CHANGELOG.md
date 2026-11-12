# Changelog

## 3.1.0 (2026-10-02)

### Features

- `groupBy` accepts a function returning several keys. (#466)

### Fixes

- `stableSort` no longer reorders equal items in Safari. (#470)

## 3.0.0 (2026-08-19)

### Removals

- `paginate` no longer accepts a page size of 0 (it used to mean "everything"). (#451)

### Features

- `paginate` returns the number of pages. (#449)

<!--
  This file is assembled by scripts/release.ts from the fragments in changes/ (one file per change, named
  <issue>.<type>.md) and the fragments are deleted when a release is cut. Edits made here by hand are overwritten.
-->
