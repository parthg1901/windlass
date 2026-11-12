#!/bin/sh
# Builds the repository's history (the eval copies a plain directory), then removes itself.
set -e
git init -q -b main
git config user.name "Sam Example"
git config user.email "sam@example.com"
git config commit.gpgsign false
mkdir .hold
mv src/upload.ts README.md .hold/
git add package.json src/limits.ts
GIT_AUTHOR_DATE="2026-09-01T10:00:00Z" GIT_COMMITTER_DATE="2026-09-01T10:00:00Z" git commit -q -m "build: start the upload service" -m "Refs: #3"
mv .hold/upload.ts src/upload.ts
git add src/upload.ts
GIT_AUTHOR_DATE="2026-09-03T15:20:00Z" GIT_COMMITTER_DATE="2026-09-03T15:20:00Z" git commit -q -m "upload: add a size limit" -m "Refs: #12"
mv .hold/README.md README.md
rmdir .hold
git add README.md
GIT_AUTHOR_DATE="2026-09-09T09:05:00Z" GIT_COMMITTER_DATE="2026-09-09T09:05:00Z" git commit -q -m "docs: describe the upload limits" -m "Refs: #15"
printf '\nexport const MIN_BYTES = 1\n' >> src/limits.ts
git add src/limits.ts
GIT_AUTHOR_DATE="2026-10-20T13:41:00Z" GIT_COMMITTER_DATE="2026-10-20T13:41:00Z" git commit -q -m "upload: reject empty files" -m "Refs: #71"
rm -f setup.sh
