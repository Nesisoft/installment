/**
 * Common surface for an SMS provider. The orchestration layer (Phase 7+) talks
 * to this interface so providers are interchangeable behind a feature flag or
 * a fallback chain.
 */

export interface SmsMessage {
  /** Recipient phone in E.164 form (e.g. +233244123456). */
  to: string;
  /** Provider-registered sender id (alphanumeric, ≤11 chars typically). */
  sender: string;
  /** Already-rendered message text. */
  message: string;
}

export type SmsStatus = 'queued' | 'sent' | 'failed';

export interface SmsResult {
  /** Provider's message id where available. */
  id?: string;
  status: SmsStatus;
  rawResponse: unknown;
}

export interface SmsClient {
  send(message: SmsMessage): Promise<SmsResult>;
}

export class SmsError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SmsError';
  }
}

export interface SmsClientBaseOptions {
  /** Defaults to global fetch; tests inject a stub. */
  fetchImpl?: typeof fetch;
  /** Per-request abort timeout. Default 15s. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
