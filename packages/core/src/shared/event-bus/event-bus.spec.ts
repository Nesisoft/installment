import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './event-bus';

describe('EventBus', () => {
  it('delivers a published payload to a subscriber', async () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.subscribe('schedule.paid', handler);

    await bus.publish('schedule.paid', { scheduleId: 's1' });

    expect(handler).toHaveBeenCalledWith({ scheduleId: 's1' });
  });

  it('invokes every handler and awaits async ones', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.subscribe('e', async () => {
      await new Promise((r) => setTimeout(r, 5));
      order.push('a');
    });
    bus.subscribe('e', () => {
      order.push('b');
    });

    await bus.publish('e', 1);
    expect(order.sort()).toEqual(['a', 'b']);
  });

  it('unsubscribe stops delivery and prunes the listener set', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.subscribe('e', handler);
    expect(bus.listenerCount('e')).toBe(1);
    off();
    expect(bus.listenerCount('e')).toBe(0);
  });

  it('publishing with no subscribers is a no-op', async () => {
    const bus = new EventBus();
    await expect(bus.publish('nobody', {})).resolves.toBeUndefined();
  });

  it('isolates a failing handler and routes it to onError', async () => {
    const onError = vi.fn();
    const bus = new EventBus(onError);
    const good = vi.fn();
    bus.subscribe('e', () => {
      throw new Error('handler boom');
    });
    bus.subscribe('e', good);

    await expect(bus.publish('e', 'p')).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledWith('p');
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as Error).message).toBe('handler boom');
    expect(onError.mock.calls[0]![1]).toBe('e');
  });
});
