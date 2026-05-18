import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTORS, isSystemActor } from './system-actors';
import { FIXTURE_USERS } from '../test-fixtures/users';

describe('SYSTEM_ACTORS', () => {
  it('matches the canonical UUIDs in DEVELOPMENT-PLAN.md §3.1 exactly', () => {
    expect(SYSTEM_ACTORS).toEqual({
      SYSTEM: '00000000-0000-0000-0000-000000000001',
      SCHEDULER: '00000000-0000-0000-0000-000000000002',
      DEBIT_WORKER: '00000000-0000-0000-0000-000000000003',
      WEBHOOK: '00000000-0000-0000-0000-000000000004',
      RECONCILER: '00000000-0000-0000-0000-000000000005',
      COLLECTIONS_BOT: '00000000-0000-0000-0000-000000000006',
      SETTLEMENT_WORKER: '00000000-0000-0000-0000-000000000007',
      VERIFY_WORKER: '00000000-0000-0000-0000-000000000008',
      NOTIFICATION_WORKER: '00000000-0000-0000-0000-000000000009',
      SEED_ADMIN: '00000000-0000-0000-0000-000000000099',
    });
  });

  it('has unique values', () => {
    const values = Object.values(SYSTEM_ACTORS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('isSystemActor recognises sentinels and rejects others', () => {
    expect(isSystemActor(SYSTEM_ACTORS.SETTLEMENT_WORKER)).toBe(true);
    expect(isSystemActor(SYSTEM_ACTORS.SEED_ADMIN)).toBe(true);
    expect(isSystemActor('paystack')).toBe(false);
    expect(isSystemActor(FIXTURE_USERS.FIXTURE_ADMIN_JANE)).toBe(false);
    expect(isSystemActor('11111111-1111-1111-1111-111111111111')).toBe(false);
  });
});

describe('FIXTURE_USERS', () => {
  it('uses the aaaaaaaa- prefixed reserved range and is disjoint from system actors', () => {
    for (const id of Object.values(FIXTURE_USERS)) {
      expect(id.startsWith('aaaaaaaa-aaaa-aaaa-aaaa-')).toBe(true);
      expect(isSystemActor(id)).toBe(false);
    }
    expect(FIXTURE_USERS).toEqual({
      FIXTURE_ADMIN_JANE: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000001',
      FIXTURE_AGENT_KOFI: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000002',
      FIXTURE_CUSTOMER_AMA: 'aaaaaaaa-aaaa-aaaa-aaaa-000000000003',
    });
  });
});
