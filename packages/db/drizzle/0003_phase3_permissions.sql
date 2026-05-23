-- ============================================================================
-- 0003_phase3_permissions.sql
-- ============================================================================
-- Adds the RBAC permissions the Phase 3 admin endpoints guard against, beyond
-- the eight seeded in 0002. Pure data (no schema change) — grants every new
-- permission to the admin role so admin remains all-powerful, plus the read
-- permissions to ops.
-- ============================================================================

BEGIN;

INSERT INTO permissions (name, description) VALUES
  ('employers:read',  'Read employers and employment links'),
  ('employers:write', 'Create / update employers and employment links'),
  ('plans:read',      'Read plan templates'),
  ('users:write',     'Create and manage users / role assignments')
ON CONFLICT (name) DO NOTHING;

-- admin gets all four new permissions.
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'admin'
    AND p.name IN ('employers:read', 'employers:write', 'plans:read', 'users:write')
ON CONFLICT DO NOTHING;

-- ops (collections agents) can read merchants/customers/employers/plans.
INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM roles r CROSS JOIN permissions p
  WHERE r.name = 'ops'
    AND p.name IN (
      'merchants:read', 'customers:read', 'employers:read', 'plans:read',
      'collections:act'
    )
ON CONFLICT DO NOTHING;

COMMIT;
