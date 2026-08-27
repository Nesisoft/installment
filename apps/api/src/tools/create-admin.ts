import { createDb } from '@installment/db';
import { AuditLogger, PasswordService, SYSTEM_ACTORS, UsersService } from '@installment/core';

/**
 * Creates a staff account from the command line.
 *
 * A fresh deployment has no way in. `0002_users_and_rbac` inserts only system
 * actors — no human, no password — and the accounts that do have passwords live
 * in `dev-fixtures.sql`, which is dev-only and must never be seeded into
 * production. `POST /admin/users/staff` requires the `users:write` permission,
 * which requires an admin, which is the account you are trying to create. This
 * script is the way past that.
 *
 * Credentials come from the environment, never from argv: arguments are visible
 * to anyone who can run `ps`, and they persist in shell history.
 *
 *   ADMIN_EMAIL=ops@yourdomain.com ADMIN_PASSWORD='...' ADMIN_NAME='Ops Lead' \
 *     pnpm create-admin
 *
 * Run it once per real operator rather than sharing one login — every audit
 * event records the actor, and a shared account makes that record worthless.
 */

const MIN_PASSWORD_LENGTH = 12;

interface Args {
  email: string;
  password: string;
  name: string;
  userType: 'admin' | 'agent';
  roles: string[];
}

function readArgs(): Args {
  const email = (process.env.ADMIN_EMAIL ?? '').trim();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const name = (process.env.ADMIN_NAME ?? '').trim();
  const userType = (process.env.ADMIN_USER_TYPE ?? 'admin').trim() as 'admin' | 'agent';

  const problems: string[] = [];
  if (!email) problems.push('ADMIN_EMAIL is required');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    problems.push(`ADMIN_EMAIL "${email}" is not a valid email`);
  if (!password) problems.push('ADMIN_PASSWORD is required');
  else if (password.length < MIN_PASSWORD_LENGTH) {
    // Stricter than the API's own 8-character floor. This is the most
    // privileged account in the system and it is created once, by hand.
    problems.push(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (!name) problems.push('ADMIN_NAME is required');
  if (userType !== 'admin' && userType !== 'agent') {
    problems.push('ADMIN_USER_TYPE must be "admin" or "agent"');
  }

  if (problems.length) {
    console.error('Cannot create the account:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error(
      '\nUsage:\n  ADMIN_EMAIL=ops@yourdomain.com ADMIN_PASSWORD=<strong password> \\\n' +
        '  ADMIN_NAME="Ops Lead" pnpm create-admin\n' +
        '\nOptional: ADMIN_USER_TYPE=agent (defaults to admin), ADMIN_ROLES=admin,ops',
    );
    process.exit(1);
  }

  const roles = (process.env.ADMIN_ROLES ?? (userType === 'admin' ? 'admin' : 'ops'))
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  return { email, password, name, userType, roles };
}

async function main(): Promise<void> {
  const args = readArgs();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString });
  try {
    const users = new UsersService(db, new AuditLogger(), new PasswordService());

    const existing = await users.findByEmail(args.email).catch(() => null);
    if (existing) {
      // Refuse rather than silently resetting someone's password — an operator
      // re-running this after a typo should not be able to take over an account.
      console.error(`A user with email ${args.email} already exists. Refusing to overwrite it.`);
      process.exit(1);
    }

    const user = await users.createStaff(
      {
        email: args.email,
        name: args.name,
        password: args.password,
        user_type: args.userType,
        roleNames: args.roles,
      },
      { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' },
    );

    // The password is deliberately not echoed: it is already in the operator's
    // hands, and printing it would put it in CI logs and terminal scrollback.
    console.log('Created:');
    console.log(`  id        ${user.id}`);
    console.log(`  email     ${user.email}`);
    console.log(`  name      ${user.name}`);
    console.log(`  type      ${user.user_type}`);
    console.log(`  roles     ${args.roles.join(', ')}`);
    console.log('\nSign in at the admin console with that email and the password you supplied.');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
