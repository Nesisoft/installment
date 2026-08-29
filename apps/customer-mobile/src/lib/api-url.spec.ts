import { describe, expect, it } from 'vitest';
import { resolveApiBaseUrl } from './api-url';

/**
 * The one piece of configuration a developer gets wrong on their first run, and
 * the one whose failure mode reads as something else entirely — a dropped
 * packet on a handset is a twenty-second hang, not a refusal, so a wrong
 * address looks like a bad network.
 *
 * Every case below is a real setup someone runs.
 */
describe('resolveApiBaseUrl', () => {
  it('derives the API host from Metro, which is how the phone reached the bundle', () => {
    // The case the whole change exists for: a physical handset, no .env at all.
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.20:8081' })).toBe('http://192.168.1.20:3000');
  });

  it('handles the iOS simulator and the web preview', () => {
    expect(resolveApiBaseUrl({ hostUri: 'localhost:8081' })).toBe('http://localhost:3000');
  });

  it("handles the Android emulator's host alias", () => {
    expect(resolveApiBaseUrl({ hostUri: '10.0.2.2:8081' })).toBe('http://10.0.2.2:3000');
  });

  it('lets an explicit EXPO_PUBLIC_API_URL win over the derivation', () => {
    // Someone pointing at staging, or a colleague's machine, has made a
    // decision; a derivation must not second-guess it.
    expect(
      resolveApiBaseUrl({ explicit: 'https://api.staging.ejua.gh', hostUri: '192.168.1.20:8081' }),
    ).toBe('https://api.staging.ejua.gh');
  });

  it('ignores an explicit value that is only whitespace', () => {
    expect(resolveApiBaseUrl({ explicit: '   ', hostUri: '192.168.1.20:8081' })).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('trims a trailing slash so joins do not double it', () => {
    expect(resolveApiBaseUrl({ explicit: 'https://api.ejua.gh/' })).toBe('https://api.ejua.gh');
  });

  /**
   * `--tunnel` proxies METRO, not the API. Deriving from an ngrok-style host
   * would point the app at a domain that serves bundles and nothing else — so
   * the fallback is correct precisely because it refuses to guess.
   */
  it.each([
    'abc-def.exp.direct:80',
    'random-words.ngrok.io',
    'xyz.trycloudflare.com',
    'my-machine.local:8081',
  ])('refuses to derive from the tunnel/mDNS host %s', (hostUri) => {
    expect(resolveApiBaseUrl({ hostUri, configured: 'http://localhost:3000' })).toBe(
      'http://localhost:3000',
    );
  });

  it('falls back to app.json when there is no hostUri at all', () => {
    // A release build has no dev server, so nothing to derive from.
    expect(resolveApiBaseUrl({ configured: 'https://api.ejua.gh' })).toBe('https://api.ejua.gh');
  });

  it('still answers something when every source is missing', () => {
    // A misconfiguration, but a wrong URL beats a crash on a blank screen.
    expect(resolveApiBaseUrl({})).toBe('http://localhost:3000');
  });

  it('honours a non-default API port', () => {
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.20:8081', port: '4000' })).toBe(
      'http://192.168.1.20:4000',
    );
  });

  it('ignores a blank port rather than emitting a trailing colon', () => {
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.20:8081', port: '  ' })).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('tolerates a hostUri that carries a scheme', () => {
    expect(resolveApiBaseUrl({ hostUri: 'http://192.168.1.20:8081' })).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('tolerates a hostUri with no port', () => {
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.20' })).toBe('http://192.168.1.20:3000');
  });

  it('tolerates a hostUri carrying a path', () => {
    expect(resolveApiBaseUrl({ hostUri: '192.168.1.20:8081/--/expo-development-client' })).toBe(
      'http://192.168.1.20:3000',
    );
  });

  it('does not mangle an IPv6 loopback into a partial address', () => {
    // Splitting an unbracketed IPv6 literal at the first colon would leave '::'
    // and derive a nonsense host, so it must not be treated as host:port.
    expect(resolveApiBaseUrl({ hostUri: '::1', configured: 'http://localhost:3000' })).toBe(
      'http://::1:3000',
    );
  });

  it.each(['', '   '])('ignores an empty hostUri (%p)', (hostUri) => {
    expect(resolveApiBaseUrl({ hostUri, configured: 'https://api.ejua.gh' })).toBe(
      'https://api.ejua.gh',
    );
  });

  it('rejects a hostname that merely looks numeric', () => {
    expect(
      resolveApiBaseUrl({ hostUri: '192.168.1.20.example.com:8081', configured: 'http://x:3000' }),
    ).toBe('http://x:3000');
  });
});
