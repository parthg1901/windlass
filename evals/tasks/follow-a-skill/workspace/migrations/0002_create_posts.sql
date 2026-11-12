-- migrate:up
CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);
-- migrate:down
DROP TABLE posts;
