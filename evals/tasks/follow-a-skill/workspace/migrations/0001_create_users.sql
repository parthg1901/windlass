-- migrate:up
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
-- migrate:down
DROP TABLE users;
