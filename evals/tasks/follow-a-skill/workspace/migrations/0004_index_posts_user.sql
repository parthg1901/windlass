-- migrate:up
CREATE INDEX posts_user_id ON posts(user_id);
-- migrate:down
DROP INDEX posts_user_id;
