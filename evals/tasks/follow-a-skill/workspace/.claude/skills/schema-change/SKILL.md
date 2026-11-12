---
name: schema-change
description: How to change the database schema in this project (tables, columns, indexes). Use for any task that adds or changes a table or column.
---
# Changing the schema

Migrations in `migrations/` have been applied to production in order. Never edit or renumber one that exists:
every change is a new file.

1. Create `migrations/NNNN_<what_it_does>.sql`, where NNNN is the next number (zero-padded to four digits) and the
   rest is snake_case. It has two sections, each starting with a marker line:

       -- migrate:up
       <the change>
       -- migrate:down
       <what undoes it exactly>

   The down section must really undo the up section (SQLite supports `ALTER TABLE ... DROP COLUMN`).
2. Regenerate the schema snapshot: `bun scripts/schema-dump.ts`. It applies every migration to an empty database
   and rewrites `schema.sql`. Do not edit `schema.sql` by hand; reviewers diff it.
3. Add one line to `docs/schema-changes.md` under `## Unreleased`, newest first:
   `- NNNN: <what changed, in plain words>`.
4. Run `bun test`.
