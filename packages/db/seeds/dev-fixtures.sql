-- ============================================================================
-- dev-fixtures.sql
-- ============================================================================
-- Dev / test-only user rows. Never run in production — these IDs are reserved
-- per DEVELOPMENT-PLAN.md §3.1 (SEED_ADMIN in the 00..0099 slot, FIXTURE_*
-- in the aaaaaaaa-...-prefixed range). Re-applies safely thanks to ON CONFLICT.
-- ============================================================================

-- Dev password for the back-office fixtures is "password123" (bcrypt, 12 rounds).
-- Customers authenticate via phone OTP, so Ama has no password.
INSERT INTO users (id, email, name, user_type, is_active, password_hash) VALUES
  ('00000000-0000-0000-0000-000000000099', 'seed-admin@installment.local',     'Seed Admin',         'admin',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000001', 'jane.admin@fixture.local',         'Fixture: Admin Jane', 'admin',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000002', 'kofi.agent@fixture.local',         'Fixture: Agent Kofi', 'agent',    TRUE, '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-000000000003', 'ama.customer@fixture.local',       'Fixture: Customer Ama','customer', TRUE, NULL)
ON CONFLICT (id) DO NOTHING;

-- Backfill the dev password for fixtures created by an earlier seed (the INSERT
-- above no-ops on existing ids). Lets you sign into the back-office apps without
-- a full db:reset. password: "password123".
UPDATE users SET password_hash = '$2a$12$PHFQt1.YVXidunA0IRa9ZO/KlZbxrr3YgO8yfuplkX1hPaLkZ1WWy'
  WHERE id IN (
    '00000000-0000-0000-0000-000000000099',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-000000000002'
  )
  AND password_hash IS NULL;

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
