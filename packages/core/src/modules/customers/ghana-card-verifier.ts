/**
 * Port for Ghana Card verification. The real implementation will integrate
 * with the National Identification Authority (NIA) API later in Phase 3+.
 * The mock returned here lets the rest of the engine proceed in Phase 3.
 */

export interface GhanaCardVerificationInput {
  ghana_card_number: string;
  ghana_card_image_key: string;
}

export interface GhanaCardVerificationResult {
  verified: boolean;
  /** Provider-supplied or mock-supplied rejection reason when not verified. */
  reason?: string;
  /** Opaque provider payload, persisted to audit metadata when present. */
  raw?: unknown;
}

export interface GhanaCardVerifier {
  verify(input: GhanaCardVerificationInput): Promise<GhanaCardVerificationResult>;
}

export interface MockGhanaCardVerifierOptions {
  /** When false, every call returns verified=false with mockReason. */
  alwaysVerified?: boolean;
  /** If set, only these card numbers verify; others fail. Wins over alwaysVerified. */
  verifiedSet?: ReadonlySet<string>;
  /** Reason returned when the mock rejects. */
  mockReason?: string;
}

export class MockGhanaCardVerifier implements GhanaCardVerifier {
  constructor(private readonly opts: MockGhanaCardVerifierOptions = {}) {}

  verify(input: GhanaCardVerificationInput): Promise<GhanaCardVerificationResult> {
    const { alwaysVerified = true, verifiedSet, mockReason = 'Mock rejection' } = this.opts;

    if (verifiedSet) {
      const ok = verifiedSet.has(input.ghana_card_number);
      return Promise.resolve(
        ok ? { verified: true, raw: { mock: true } } : { verified: false, reason: mockReason },
      );
    }
    return Promise.resolve(
      alwaysVerified
        ? { verified: true, raw: { mock: true } }
        : { verified: false, reason: mockReason },
    );
  }
}
