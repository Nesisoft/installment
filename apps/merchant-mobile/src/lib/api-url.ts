/**
 * Working out where the API lives, as a pure function.
 *
 * Split from `config.ts` because that module binds to `expo-constants` at import
 * time, and a unit test in a node environment cannot load a React Native module.
 * The decision worth testing is the precedence, not the binding — so it lives
 * here, with no imports at all, and `config.ts` supplies the real values.
 *
 * The problem it solves: `localhost` on a handset means the handset. Every
 * developer testing on a real device had to find their machine's LAN address,
 * write it into `.env`, and restart Metro with `-c` — and the failure when they
 * did not was a twenty-second hang and "We couldn't reach Ejua", which reads as
 * a flaky network rather than a wrong address.
 *
 * But Metro already knows that address: it is how the phone fetched the bundle
 * in the first place, and Expo hands it to the client as `hostUri`. So the
 * default is derived from it, and `EXPO_PUBLIC_API_URL` becomes an override for
 * what the derivation cannot know (a staging API, a tunnel, a colleague's
 * machine) rather than a prerequisite for running at all.
 */

/** The API's port. Metro is on 8081; only the host is shared. */
const DEFAULT_API_PORT = '3000';

/**
 * Hosts we are willing to derive from.
 *
 * `hostUri` is Metro's address, not the API's, and the two coincide only when
 * Metro is being served off the same machine on the same network — an IP
 * literal or a loopback name. Under `--tunnel` it is an ngrok-style domain that
 * proxies *Metro alone*, so deriving from it would point the app at an API that
 * is not there. Refusing to guess in that case is the whole point of the check.
 */
function isDerivableHost(host: string): boolean {
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // IPv4 literal — covers the LAN address of a laptop and the Android
  // emulator's 10.0.2.2 host alias alike.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

export interface ApiBaseUrlSources {
  /** `EXPO_PUBLIC_API_URL`, inlined at build time. Always wins when set. */
  explicit?: string;
  /** `Constants.expoConfig.hostUri` — `192.168.1.20:8081`, or undefined in a release build. */
  hostUri?: string;
  /** `expo.extra.apiBaseUrl` from app.json — the shipped default. */
  configured?: string;
  /** Overrides the API port when a deployment does not use 3000. */
  port?: string;
}

/**
 * Pure so it can be tested without a running Metro. The order is deliberate:
 * an explicit value is a decision someone made, and must never be second-guessed
 * by a derivation.
 */
export function resolveApiBaseUrl(sources: ApiBaseUrlSources): string {
  const explicit = sources.explicit?.trim();
  if (explicit) return stripTrailingSlash(explicit);

  const host = hostFromHostUri(sources.hostUri);
  if (host && isDerivableHost(host)) {
    return `http://${host}:${sources.port?.trim() || DEFAULT_API_PORT}`;
  }

  const configured = sources.configured?.trim();
  if (configured) return stripTrailingSlash(configured);

  // Last resort. Reached only in a release build with no env and no app.json
  // value, which is a misconfiguration — but a wrong URL beats a crash on a
  // screen that would otherwise render nothing.
  return `http://localhost:${DEFAULT_API_PORT}`;
}

/** `192.168.1.20:8081` → `192.168.1.20`. Tolerates a scheme and a bare host. */
function hostFromHostUri(hostUri: string | undefined): string | undefined {
  const raw = hostUri?.trim();
  if (!raw) return undefined;
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const host = withoutScheme.split('/')[0]!.split('?')[0]!;
  // Only strip a port when it really is one — an unbracketed IPv6 literal is
  // all colons, and chopping at the first would mangle it into nonsense.
  const colons = host.split(':').length - 1;
  if (colons === 1) return host.split(':')[0];
  return host;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
