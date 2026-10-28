import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb, schema } from '@installment/db';
import { AuditLogger } from '../audit/audit-logger.service';
import { PasswordService } from '../../shared/auth/password.service';
import { JwtService } from '../../shared/auth/jwt.service';
import { OtpService, type OtpStore } from '../../shared/auth/otp.service';
import { UsersService } from '../users/users.service';
import { CustomersService } from '../customers/customers.service';
import { MockGhanaCardVerifier } from '../customers/ghana-card-verifier';
import { approveGhanaCard } from '../../shared/test-fixtures/ghana-card';
import { PlanTemplatesService } from '../plans/plan-templates.service';
import { SYSTEM_ACTORS } from '../../shared/constants/system-actors';
import { FeatureCollector } from '../scoring/feature-collector';
import { ScoringEngine } from '../scoring/scoring-engine';
import type { FeatureVector } from '../scoring/types';
import { AuthService, type SmsSender } from './auth.service';

const RUN_DB = Boolean(process.env.DATABASE_URL);

class MemoryOtpStore implements OtpStore {
  map = new Map<string, string>();
  set(k: string, v: string): Promise<void> {
    this.map.set(k, v);
    return Promise.resolve();
  }
  get(k: string): Promise<string | null> {
    return Promise.resolve(this.map.get(k) ?? null);
  }
  del(k: string): Promise<number> {
    return Promise.resolve(this.map.delete(k) ? 1 : 0);
  }
  incr(k: string): Promise<number> {
    const n = Number(this.map.get(k) ?? 0) + 1;
    this.map.set(k, String(n));
    return Promise.resolve(n);
  }
}

class CapturingSms implements SmsSender {
  sent: Array<{ to: string; message: string }> = [];
  send(msg: { to: string; sender: string; message: string }): Promise<unknown> {
    this.sent.push({ to: msg.to, message: msg.message });
    return Promise.resolve({ ok: true });
  }
  /** The OTP out of the last message, the way a handset would read it. */
  code(): string {
    const last = this.sent[this.sent.length - 1]?.message ?? '';
    return /(\d{4,8})/.exec(last)?.[1] ?? '';
  }
}

/**
 * A real signup, put through a real scoring decision.
 *
 * This spec exists because of a hole that shipped and stayed invisible for
 * five slices. `gate.age_range` is a HARD GATE and it declines an age it does
 * not know — the reason string is literally "Age out of range or unknown".
 * `IdentityCollector` derives that age from `customers.date_of_birth` and from
 * nothing else. And `date_of_birth` was on the ADMIN create/update schemas
 * only: not on signup, not on the Ghana Card submission, not on the shopper's
 * own profile edit.
 *
 * So every self-signed-up customer carried a NULL birthday. Not at the first
 * gate — `gate.age_range` is the LAST of six, and a fresh account is turned
 * away by `gate.ghana_card_verified` well before its age is looked at. It bites
 * one step further in, and worse for being there: the shopper who did
 * everything asked of them, sent their Ghana Card, had it approved, waited out
 * the SIM-age rule, and is then declined on a birthday nobody ever asked for.
 *
 * Three things hid it, and each is worth naming:
 *
 *   - `packages/db/seeds/dev-fixtures.sql` sets `date_of_birth` on its
 *     customers, so the demo data always passed the gate.
 *   - the orders integration specs never let the engine decide. They call
 *     `applications.recordDecision({ outcome: 'approved' })` by hand, so no
 *     test anywhere put a signed-up customer in front of a real scoring run.
 *   - and the gate ordering itself. "Can a brand-new account borrow?" answers
 *     "no" whether or not the age hole exists, for a different and entirely
 *     expected reason — so the obvious manual check exonerates it.
 *
 * That is the gap this file closes: signup on one side, `ScoringEngine` on the
 * other, and nothing stubbed in between.
 */
describe.skipIf(!RUN_DB)('signup gives the credit engine an age it can use (integration)', () => {
  const { db, pool } = createTestDb();
  const audit = new AuditLogger();
  const passwords = new PasswordService(4);
  const users = new UsersService(db, audit, passwords);
  const customers = new CustomersService(db, audit, new MockGhanaCardVerifier());
  const jwt = new JwtService({ accessSecret: 'access-test', refreshSecret: 'refresh-test' });
  const templates = new PlanTemplatesService(db, audit);
  const collector = FeatureCollector.fromDb(db);
  const engine = new ScoringEngine();
  const ACTOR = { actorId: SYSTEM_ACTORS.SYSTEM, actorType: 'system' as const };

  afterAll(async () => {
    await pool.end();
  });

  const newPhone = () => `+23324${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;

  function stack() {
    const sms = new CapturingSms();
    const auth = new AuthService({
      users,
      passwords,
      jwt,
      otp: new OtpService(new MemoryOtpStore()),
      sms,
      smsSenderId: 'Installmt',
      customers,
    });
    return { auth, sms };
  }

  /** The three-step flow the shopper app actually uses. */
  async function signUp(dateOfBirth: string) {
    const { auth, sms } = stack();
    const phone = newPhone();
    await auth.customerSignupStart({ phone });
    const { signupToken } = await auth.customerSignupVerifyCode({ phone, code: sms.code() });
    const result = await auth.customerSignupComplete({
      signupToken,
      first_name: 'Ama',
      last_name: 'Boateng',
      date_of_birth: dateOfBirth,
      consents: { data_processing: true, credit_scoring: true, marketing: false },
    });
    return { result, phone };
  }

  /** `YYYY-MM-DD` for somebody exactly this many years old today. */
  function bornYearsAgo(years: number): string {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
    return d.toISOString().slice(0, 10);
  }

  /**
   * A signed-up shopper who has cleared every gate that stands in FRONT of the
   * age gate — because `gate.age_range` is the last of six, and without this
   * the engine short-circuits on `gate.ghana_card_verified` and the age is
   * never evaluated at all.
   *
   * This is also the honest shape of the bug: it does not bite at signup. It
   * bites the shopper who did everything asked of them — signed up, sent their
   * Ghana Card, got verified, waited out the SIM-age rule — and is then
   * declined on a birthday nobody ever asked for.
   */
  async function readyToBorrow(dateOfBirth: string): Promise<string> {
    const { phone } = await signUp(dateOfBirth);
    const customerId = await customerIdFor(phone);
    await db
      .update(schema.customers)
      // `gate.phone_age` refuses a SIM bought this morning, and a signup's
      // `phone_first_seen_at` is always now.
      .set({ phone_first_seen_at: new Date(Date.now() - 60 * 86_400_000).toISOString() })
      .where(eq(schema.customers.id, customerId));
    await approveGhanaCard(db, customerId);
    return customerId;
  }

  async function customerIdFor(phone: string): Promise<string> {
    const rows = await db
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(eq(schema.customers.phone, phone))
      .limit(1);
    return rows[0]!.id;
  }

  async function payInFour(): Promise<string> {
    const t = await templates.create(
      {
        name: `Pay in 4 ${randomUUID().slice(0, 8)}`,
        business_model: 'bnpl',
        number_of_installments: 3,
        installment_frequency_days: 7,
        down_payment_bps: 4_000,
        min_amount_pesewas: 1_000,
        max_amount_pesewas: 5_000_000,
      },
      ACTOR,
    );
    return t.id;
  }

  async function decide(customerId: string, orderAmountGhs: number, planTemplateId: string) {
    const request: FeatureVector['request'] = {
      orderAmountGhs,
      merchantCategory: 'electronics',
      planTemplateId,
      planMinGhs: 10,
      planMaxGhs: 50_000,
      downPaymentBps: 4_000,
    };
    return engine.score(await collector.collect(customerId, request));
  }

  it('stores the birthday signup asked for', async () => {
    const dob = bornYearsAgo(30);
    const { phone } = await signUp(dob);

    const rows = await db
      .select()
      .from(schema.customers)
      .where(eq(schema.customers.phone, phone))
      .limit(1);

    expect(rows[0]?.date_of_birth).toBe(dob);
  });

  it('passes the age gate for a shopper who has done everything asked of them', async () => {
    // The assertion the whole fix exists for. Before it, `ageYears` was null
    // here and this decision came back `declined` with "Age out of range or
    // unknown" — for a customer with a verified Ghana Card and nothing left to
    // give.
    const customerId = await readyToBorrow(bornYearsAgo(30));

    const decision = await decide(customerId, 200, await payInFour());

    const ageGate = decision.rulesFired.find((r) => r.ruleId === 'gate.age_range');
    expect(ageGate).toBeDefined();
    expect(ageGate?.passed).toBe(true);
    expect(decision.outcome).not.toBe('declined');
  });

  it('would have declined the same customer with no birthday', async () => {
    // Pins the mechanism rather than trusting the story: the row is emptied
    // behind the engine's back, and the same decision flips to a decline.
    const customerId = await readyToBorrow(bornYearsAgo(30));
    const template = await payInFour();
    expect((await decide(customerId, 200, template)).outcome).not.toBe('declined');

    await db
      .update(schema.customers)
      .set({ date_of_birth: null })
      .where(eq(schema.customers.id, customerId));

    const decision = await decide(customerId, 200, template);

    expect(decision.outcome).toBe('declined');
    expect(decision.rulesFired.find((r) => r.ruleId === 'gate.age_range')?.reason).toMatch(
      /unknown/i,
    );
  });

  it('is the LAST of the six hard gates, which is why it hid for so long', async () => {
    // Worth pinning: a fresh signup is declined on `gate.ghana_card_verified`
    // long before age is looked at, so the age hole is invisible to anyone
    // testing "can a new account borrow?" — the answer is no either way, for a
    // different and expected reason.
    const { phone } = await signUp(bornYearsAgo(30));
    const decision = await decide(await customerIdFor(phone), 200, await payInFour());

    expect(decision.outcome).toBe('declined');
    expect(decision.rulesFired.at(-1)?.ruleId).toBe('gate.ghana_card_verified');
    expect(decision.rulesFired.some((r) => r.ruleId === 'gate.age_range')).toBe(false);
  });

  it('refuses a signup with no date of birth at all', async () => {
    const { auth, sms } = stack();
    const phone = newPhone();
    await auth.customerSignupStart({ phone });
    const { signupToken } = await auth.customerSignupVerifyCode({ phone, code: sms.code() });

    await expect(
      auth.customerSignupComplete({
        signupToken,
        first_name: 'Ama',
        last_name: 'Boateng',
        consents: { data_processing: true, credit_scoring: true, marketing: false },
      }),
    ).rejects.toThrow();
  });

  it('refuses a minor, an impossible date and a date in the future', async () => {
    for (const bad of [
      bornYearsAgo(17),
      // The regex accepts this and `Date` rolls it into March, which would
      // register a birthday nobody typed.
      '2001-02-30',
      `${new Date().getUTCFullYear() + 1}-01-01`,
      '1700-01-01',
    ]) {
      await expect(signUp(bad)).rejects.toThrow();
    }
  });
});
