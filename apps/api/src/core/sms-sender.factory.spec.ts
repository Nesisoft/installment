import { describe, expect, it, vi } from 'vitest';
import { ArkeselSmsClient, HubtelSmsClient } from '@installment/sms-client';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { validateEnv } from '../config/env.validation';
import { createSmsSender } from './sms-sender.factory';
import { ConsoleSmsSender, maskPhone } from './console-sms-sender';

/** A ConfigService over a plain object, which is all the factory reads. */
function configOf(overrides: Partial<Record<string, unknown>> = {}): ConfigService<Env, true> {
  const env = validateEnv({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', ...overrides });
  return { get: (key: string) => (env as Record<string, unknown>)[key] } as ConfigService<
    Env,
    true
  >;
}

/**
 * S9 — SMS actually sends.
 *
 * `@installment/sms-client` shipped complete, with both providers tested, and
 * was a dependency of nothing. The API only ever wired the console sender, so
 * on a real deployment no customer could log in — customer auth is phone+OTP
 * only and the OTP terminated in a log line.
 */
describe('createSmsSender', () => {
  it('builds a Hubtel client when configured for one', () => {
    const sender = createSmsSender(
      configOf({
        SMS_PROVIDER: 'hubtel',
        HUBTEL_CLIENT_ID: 'cid',
        HUBTEL_CLIENT_SECRET: 'secret',
      }),
    );
    expect(sender).toBeInstanceOf(HubtelSmsClient);
  });

  it('builds an Arkesel client when configured for one', () => {
    const sender = createSmsSender(configOf({ SMS_PROVIDER: 'arkesel', ARKESEL_API_KEY: 'key' }));
    expect(sender).toBeInstanceOf(ArkeselSmsClient);
  });

  it('falls back to the console sender in development', () => {
    expect(createSmsSender(configOf())).toBeInstanceOf(ConsoleSmsSender);
  });
});

describe('SMS environment validation', () => {
  it('refuses to boot production on the console sender', () => {
    // The failure this prevents is silent: every OTP would be "sent" to a log
    // file and every customer would be locked out of their own account.
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
      }),
    ).toThrow(/SMS_PROVIDER=console delivers nothing/);
  });

  it('refuses to boot production with OTP bodies going to the log', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        NODE_ENV: 'production',
        SMS_PROVIDER: 'arkesel',
        ARKESEL_API_KEY: 'key',
        SMS_LOG_BODY: 'true',
      }),
    ).toThrow(/writes login OTPs to the log/);
  });

  it('refuses a provider selected without its credentials', () => {
    // Checked at boot in every environment: the alternative is discovering it
    // on the first customer login attempt.
    expect(() =>
      validateEnv({ DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', SMS_PROVIDER: 'hubtel' }),
    ).toThrow(/HUBTEL_CLIENT_ID and HUBTEL_CLIENT_SECRET/);

    expect(() =>
      validateEnv({
        DATABASE_URL: 'postgres://x',
        REDIS_URL: 'redis://x',
        SMS_PROVIDER: 'arkesel',
      }),
    ).toThrow(/ARKESEL_API_KEY/);
  });

  it('accepts a fully configured production deployment', () => {
    const env = validateEnv({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      NODE_ENV: 'production',
      SMS_PROVIDER: 'hubtel',
      HUBTEL_CLIENT_ID: 'cid',
      HUBTEL_CLIENT_SECRET: 'secret',
      // "Fully configured" grew a member: a production boot also refuses
      // PUSH_PROVIDER=console, because a merchant who is never told an order
      // arrived does not confirm it.
      PUSH_PROVIDER: 'expo',
      // And again: the published development JWT secrets are refused too.
      JWT_ACCESS_SECRET: 'a'.repeat(32),
      JWT_REFRESH_SECRET: 'b'.repeat(32),
    });
    expect(env.SMS_PROVIDER).toBe('hubtel');
    expect(env.SMS_LOG_BODY).toBe(false);
  });
});

describe('ConsoleSmsSender', () => {
  it('never logs the message body by default', async () => {
    const logged: string[] = [];
    const sender = new ConsoleSmsSender();
    vi.spyOn(
      (sender as unknown as { logger: { log: (m: string) => void } }).logger,
      'log',
    ).mockImplementation((m: string) => void logged.push(m));

    const body = 'Your Installment verification code is 481920.';
    await sender.send({ to: '+233244123456', sender: 'Installmt', message: body });

    // The body is the OTP. A log line containing it is a live credential.
    expect(logged[0]).not.toContain('481920');
    expect(logged[0]).not.toContain('+233244123456');
    // A length is enough to tell a truncated template from a rendered one.
    expect(logged[0]).toContain(`chars=${body.length}`);
  });

  it('logs the body only when a developer explicitly asks', async () => {
    const logged: string[] = [];
    const sender = new ConsoleSmsSender(true);
    vi.spyOn(
      (sender as unknown as { logger: { log: (m: string) => void } }).logger,
      'log',
    ).mockImplementation((m: string) => void logged.push(m));

    await sender.send({ to: '+233244123456', sender: 'Installmt', message: 'code 481920' });
    expect(logged[0]).toContain('code 481920');
  });

  it('reports queued, not sent — nothing reached a carrier', async () => {
    const result = await new ConsoleSmsSender().send({
      to: '+233244123456',
      sender: 'Installmt',
      message: 'hi',
    });
    expect(result).toMatchObject({ status: 'queued' });
  });

  it('masks a phone number to its first four and last three digits', () => {
    expect(maskPhone('+233244123456')).toBe('+233******456');
    expect(maskPhone('0244123456')).toBe('0244***456');
    expect(maskPhone('12345')).toBe('*****');
  });
});
