CREATE TABLE posts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT ''
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
, display_name TEXT);

CREATE INDEX posts_user_id ON posts(user_id);
