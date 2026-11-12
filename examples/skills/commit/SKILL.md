---
name: commit
description: >
  How to commit when other people or agents work in the same working tree:
  stage and commit only your own paths, with a one-line conventional message.
  Use whenever you are asked to commit.
---

# Committing in a shared working tree

Other work may be in progress in the same checkout. A commit must contain exactly your change and nothing else.

1. Look first: `git status --short`. Note which changed paths are yours. If you are unsure about a path, leave it out and say so.
2. Never `git add -A`, `git add .` or `git commit -a`. Stage an explicit list: `git add <path> <path> ...`.
3. Commit the same list, so that something another person staged meanwhile is not swept in: `git commit -m "<message>" -- <path> <path> ...`.
4. The message is one line in conventional form, `type(scope): summary`, for example `feat(mcp): client and bridge tools` or `fix(engine): close the store on shutdown`. Types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`. No body, no trailers, no co-author lines.
5. If git reports `index.lock` exists, another git command is running: wait a few seconds and retry. Do not delete the lock unless you know its process is gone.
6. Commit locally. Do not push unless you were asked to.
7. Report the commit hash (`git log --oneline -1`).
