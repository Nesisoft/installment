import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import { ReminderCron } from './reminder.cron';
import type { Env } from '../config/env.validation';

function makeConfig(enabled: boolean): ConfigService<Env, true> {
  return { get: vi.fn(() => enabled) } as unknown as ConfigService<Env, true>;
}
function makeLogger(): PinoLogger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as PinoLogger;
}

describe('ReminderCron', () => {
  it('sweeps tomorrow and logs when reminders were sent', async () => {
    const sendUpcomingReminders = vi.fn(async () => ({
      forDate: '2026-06-21',
      candidates: 3,
      sent: 2,
      skipped: 1,
    }));
    const logger = makeLogger();
    const cron = new ReminderCron({ sendUpcomingReminders } as never, makeConfig(true), logger);

    await cron.run();

    expect(sendUpcomingReminders).toHaveBeenCalledOnce();
    const [forDate] = (sendUpcomingReminders as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(forDate).toMatch(/^\d{4}-\d{2}-\d{2}$/); // YYYY-MM-DD shape
    expect(logger.info).toHaveBeenCalledOnce();
  });

  it('stays quiet when no installments are due tomorrow', async () => {
    const sendUpcomingReminders = vi.fn(async () => ({
      forDate: '2026-06-21',
      candidates: 0,
      sent: 0,
      skipped: 0,
    }));
    const logger = makeLogger();
    const cron = new ReminderCron({ sendUpcomingReminders } as never, makeConfig(true), logger);
    await cron.run();
    expect(sendUpcomingReminders).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is a no-op when ENABLE_SCHEDULED_WORKERS is false', async () => {
    const sendUpcomingReminders = vi.fn();
    const cron = new ReminderCron(
      { sendUpcomingReminders } as never,
      makeConfig(false),
      makeLogger(),
    );
    await cron.run();
    expect(sendUpcomingReminders).not.toHaveBeenCalled();
  });

  it('swallows errors and logs them', async () => {
    const sendUpcomingReminders = vi.fn(async () => {
      throw new Error('db down');
    });
    const logger = makeLogger();
    const cron = new ReminderCron({ sendUpcomingReminders } as never, makeConfig(true), logger);
    await expect(cron.run()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
