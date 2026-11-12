---
description: Draft release notes for a version from the commits since the previous one
argument-hint: <version> [previous-version]
---
Draft the release notes for version $1.

Look at the commits since $2 (if no previous version is given, since the latest tag) with git log, group them into
Added, Changed and Fixed, and write one line per user-visible change. Leave out refactors and test-only commits.
Do not edit any file: show me the notes.
