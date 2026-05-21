-- ============================================================================
-- dev-fixtures.sql
-- ============================================================================
-- Dev / test-only user rows. Never run in production — these IDs are reserved
-- per DEVELOPMENT-PLAN.md §3.1 (SEED_ADMIN in the 00..0099 slot, FIXTURE_*
-- in the aaaaaaaa-...-prefixed range). Re-applies safely thanks to ON CONFLICT.
-- ============================================================================

INSERT INTO users (id, email, name, user_type, is_active) VALUES
  ('00000000-0000-0000-0000-000000000099', 'seed-admin@installment.local',     'Seed Admin',         'admin',    TRUE),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'jane.admin@fixture.local',         'Fixture: Admin Jane', 'admin',    TRUE),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000002', 'kofi.agent@fixture.local',         'Fixture: Agent Kofi', 'agent',    TRUE),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000003', 'ama.customer@fixture.local',       'Fixture: Customer Ama','customer', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Grant the admin role to the two admin fixtures (and SEED_ADMIN).
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id IN (
    '00000000-0000-0000-0000-000000000099',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001'
  )
  AND r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Agent fixture -> ops role.
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002' AND r.name = 'ops'
ON CONFLICT DO NOTHING;

-- Customer fixture -> customer role.
INSERT INTO user_roles (user_id, role_id)
  SELECT u.id, r.id
  FROM users u CROSS JOIN roles r
  WHERE u.id = 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003' AND r.name = 'customer'
ON CONFLICT DO NOTHING;
