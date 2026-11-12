-- migrate:up
ALTER TABLE users ADD COLUMN display_name TEXT;
-- migrate:down
ALTER TABLE users DROP COLUMN display_name;
