-- ============================================================================
-- 0027_user_password_lifecycle.sql  (Passwords can be changed, reset, and end sessions)
-- ============================================================================
-- Staff and sellers sign in with a password, and until now nobody could change
-- one: not their own, and not anyone else's. A member of staff kept the
-- password an administrator typed for them for as long as they worked here,
-- and a forgotten password was a database edit.
--
-- Three columns make the lifecycle possible:
--
--   token_version         Every session token carries the version it was
--                         issued at. Changing or resetting a password bumps
--                         it, so a refresh token issued before the change is
--                         refused: the other devices are signed out, and a
--                         stolen session stops renewing. Access tokens are
--                         stateless and expire within their fifteen minutes.
--   must_change_password  Set when someone other than the owner chose the
--                         password (an administrator adding staff, or
--                         resetting a password). Such a login holds no
--                         permissions until the owner picks their own.
--   password_changed_at   When the password last changed, for the audit trail
--                         and for the console's staff list.
--
-- Existing tokens carry no version and are read as version 0, which is what
-- every existing row starts at, so nobody is signed out by this migration.
-- ============================================================================

BEGIN;

ALTER TABLE users
  ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN password_changed_at TIMESTAMPTZ;

ALTER TABLE users
  ADD CONSTRAINT users_token_version_non_negative CHECK (token_version >= 0);

COMMENT ON COLUMN users.token_version IS
  'Bumped on a password change or reset; refresh tokens issued at an older version are refused.';
COMMENT ON COLUMN users.must_change_password IS
  'The password was chosen by someone else; the login holds no permissions until its owner changes it.';
COMMENT ON COLUMN users.password_changed_at IS
  'When the password last changed, by its owner or by a reset.';

COMMIT;
