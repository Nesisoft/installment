-- ============================================================================
-- 0002_users_and_rbac.sql
-- ============================================================================
-- Adds the `users` table that the entire engine has been promising since 0001,
-- the RBAC tables (roles, permissions, and the two grant join tables), and the
-- FK constraints on actor_id columns that were intentionally deferred.
--
-- Conventions (same as 0001):
--   * PKs and FKs defined inline
--   * Timestamps timestamptz, UTC
--   * Soft-delete via deleted_at where applicable
--   * CHECK lists encode invariants the application also enforces
--
-- IMPORTANT — actor_id convention (re-stated from 0001):
--   * audit_events.actor_id stays TEXT and gets NO FK constraint — it must
--     accept non-UUID literals like 'paystack' for webhook actors.
--   * collections_cases.assigned_agent_id, collections_actions.performed_by,
--     and rule_definitions.created_by are UUID columns and DO gain FKs here.
--   * Every FK on a historical/audit-like column uses ON DELETE SET NULL so
--     the audit trail survives if a user row is later deleted.
--
-- System-actor seeding mirrors DEVELOPMENT-PLAN.md §3.1 byte-for-byte. These
-- ten UUIDs are reserved across the codebase; they appeared in actor columns
-- during Phases 1–2 and are now backed by real `users` rows. SEED_ADMIN and
-- the FIXTURE_* IDs are dev/test only — they live in seeds/dev-fixtures.sql,
-- not here, so production never sees them.
-- ============================================================================

BEGIN;

-- ============================================================================
-- 1. USERS
-- ============================================================================

CREATE TABLE users (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email                       CITEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,

  -- Auth surface (Phase 3 task 7+):
  --   * staff/admin/agent log in with email + password_hash (bcrypt)
  --   * customers log in with phone + OTP (no password_hash)
  --   * system actors never log in (both nullable)
  password_hash               TEXT,
  phone                       TEXT UNIQUE,

  -- High-level user kind. Granular permissions go through user_roles below.
  user_type                   TEXT NOT NULL
    CHECK (user_type IN ('system', 'admin', 'agent', 'customer', 'merchant')),

  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at               TIMESTAMPTZ,

  metadata                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at                  TIMESTAMPTZ
);

CREATE INDEX users_user_type_idx ON users (user_type) WHERE deleted_at IS NULL;
CREATE INDEX users_active_idx    ON users (is_active) WHERE is_active AND deleted_at IS NULL;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE users IS 'Real and synthetic actors. System actors (user_type=system) are seeded and never login.';

-- ============================================================================
-- 2. SYSTEM ACTOR SEEDS — must match SYSTEM_ACTORS in @installment/core
-- ============================================================================

INSERT INTO users (id, email, name, user_type, is_active) VALUES
  ('00000000-0000-0000-0000-000000000001', 'system@installment.local',              'System',              'system', TRUE),
  ('00000000-0000-0000-0000-000000000002', 'scheduler@installment.local',           'Scheduler',           'system', TRUE),
  ('00000000-0000-0000-0000-000000000003', 'debit-worker@installment.local',        'Debit Worker',        'system', TRUE),
  ('00000000-0000-0000-0000-000000000004', 'webhook@installment.local',             'Webhook Handler',     'system', TRUE),
  ('00000000-0000-0000-0000-000000000005', 'reconciler@installment.local',          'Reconciler',          'system', TRUE),
  ('00000000-0000-0000-0000-000000000006', 'collections-bot@installment.local',     'Collections Bot',     'system', TRUE),
  ('00000000-0000-0000-0000-000000000007', 'settlement-worker@installment.local',   'Settlement Worker',   'system', TRUE),
  ('00000000-0000-0000-0000-000000000008', 'verify-worker@installment.local',       'Verify Worker',       'system', TRUE),
  ('00000000-0000-0000-0000-000000000009', 'notification-worker@installment.local', 'Notification Worker', 'system', TRUE);

-- ============================================================================
-- 3. RBAC — roles, permissions, and the two join tables
-- ============================================================================

CREATE TABLE roles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Format: 'resource:action' (e.g. 'merchants:write').
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions (
  role_id       UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE INDEX role_permissions_permission_idx ON role_permissions (permission_id);

CREATE TABLE user_roles (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id    UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- ============================================================================
-- 4. SEED CANONICAL ROLES + PERMISSIONS
-- ============================================================================

INSERT INTO roles (name, description) VALUES
  ('admin',          'Platform administrator — full access'),
  ('ops',            'Operations / collections agent'),
  ('merchant_owner', 'Authenticated merchant business owner'),
  ('customer',       'Authenticated customer'),
  ('system',         'Internal system actor — no human use');

INSERT INTO permissions (name, description) VALUES
  ('merchants:read',       'Read merchants'),
  ('merchants:write',      'Create or update merchants'),
  ('customers:read',       'Read customer profiles'),
  ('customers:write',      'Create or update customer profiles'),
  ('applications:review',  'Approve / decline / counter-offer applications'),
  ('collections:act',      'Take action on collections cases'),
  ('plans:write',          'Create / update plan templates'),
  ('audit:read',           'View audit log');

-- Admin role gets every seeded permission. Other roles get more granular
-- assignments in subsequent migrations as endpoints are added.
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'admin';

-- ============================================================================
-- 5. ORPHAN ACTOR_ID SANITY CHECK — refuse to add FKs if any UUID column has
--    a value not present in users. In practice this should be 0 at Phase 3.
-- ============================================================================

DO $$
DECLARE
  orphan_count INTEGER;
BEGIN
  SELECT count(*) INTO orphan_count FROM (
    SELECT assigned_agent_id AS id FROM collections_cases   WHERE assigned_agent_id IS NOT NULL
    UNION ALL
    SELECT performed_by              FROM collections_actions WHERE performed_by      IS NOT NULL
    UNION ALL
    SELECT created_by                FROM rule_definitions    WHERE created_by        IS NOT NULL
  ) refs
  WHERE refs.id NOT IN (SELECT id FROM users);

  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Found % orphan actor_id references — refusing to add FK constraints; reconcile data first', orphan_count;
  END IF;
END $$;

-- ============================================================================
-- 6. PROMOTE PENDING ACTOR COLUMNS TO REAL FOREIGN KEYS
--    NOTE: audit_events.actor_id stays TEXT and intentionally has NO FK.
-- ============================================================================

ALTER TABLE collections_cases
  ADD CONSTRAINT collections_cases_assigned_agent_fk
  FOREIGN KEY (assigned_agent_id) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE collections_actions
  ADD CONSTRAINT collections_actions_performed_by_fk
  FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE rule_definitions
  ADD CONSTRAINT rule_definitions_created_by_fk
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;

COMMIT;
