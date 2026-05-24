export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * In-process domain event bus. Domain events are published AFTER a DB
 * transaction commits (see {@link runInTransaction}'s afterCommit hook), so a
 * failing subscriber must never roll back or break the publisher — handler
 * rejections are isolated and reported via the optional `onError` sink.
 */
export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  constructor(private readonly onError?: (error: unknown, event: string) => void) {}

  /** Register a handler. Returns an unsubscribe function. */
  subscribe<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler);
    return () => {
      const s = this.handlers.get(event);
      s?.delete(handler as EventHandler);
      if (s && s.size === 0) this.handlers.delete(event);
    };
  }

  /**
   * Invoke every handler for `event`. Resolves once all settle; a throwing or
   * rejecting handler is caught and routed to `onError`, never propagated.
   */
  async publish<T = unknown>(event: string, payload: T): Promise<void> {
    const set = this.handlers.get(event);
    if (!set || set.size === 0) return;

    const results = await Promise.allSettled(
      [...set].map((handler) => Promise.resolve().then(() => handler(payload))),
    );
    for (const r of results) {
      if (r.status === 'rejected') this.onError?.(r.reason, event);
    }
  }

  /** Test/introspection helper: number of handlers registered for an event. */
  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }
}
