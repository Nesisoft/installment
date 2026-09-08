import { describe, expect, it, vi } from 'vitest';
import { registerForPush, type PushRegistrationPorts } from './push-registration';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

function ports(overrides: Partial<PushRegistrationPorts> = {}): PushRegistrationPorts {
  return {
    isPhysicalDevice: true,
    platform: 'android',
    projectId: 'proj-1',
    appVersion: '1.0.0',
    deviceName: "Ama's Tecno",
    getPermission: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
    requestPermission: vi.fn(() => Promise.resolve({ granted: true, canAskAgain: true })),
    getExpoToken: vi.fn(() => Promise.resolve(TOKEN)),
    register: vi.fn(() => Promise.resolve({})),
    ...overrides,
  };
}

describe('registerForPush', () => {
  it('posts the token the server can send to', async () => {
    const p = ports();

    expect(await registerForPush(p)).toEqual({ status: 'registered', token: TOKEN });
    expect(p.register).toHaveBeenCalledWith({
      expo_token: TOKEN,
      platform: 'android',
      app_version: '1.0.0',
      device_name: "Ama's Tecno",
    });
  });

  it('asks for permission when it has not been asked yet', async () => {
    const requestPermission = vi.fn(() => Promise.resolve({ granted: true, canAskAgain: false }));
    const p = ports({
      getPermission: vi.fn(() => Promise.resolve({ granted: false, canAskAgain: true })),
      requestPermission,
    });

    expect((await registerForPush(p)).status).toBe('registered');
    expect(requestPermission).toHaveBeenCalledOnce();
  });

  it('does not ask again once the answer was no', async () => {
    // iOS shows the system prompt once per install; a second call resolves with
    // the same refusal. Asking anyway would be a round trip that cannot succeed.
    const requestPermission = vi.fn(() => Promise.resolve({ granted: false, canAskAgain: false }));
    const p = ports({
      getPermission: vi.fn(() => Promise.resolve({ granted: false, canAskAgain: false })),
      requestPermission,
    });

    expect(await registerForPush(p)).toEqual({ status: 'skipped', reason: 'permission-denied' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(p.getExpoToken).not.toHaveBeenCalled();
    expect(p.register).not.toHaveBeenCalled();
  });

  it('never mints a token on a simulator', async () => {
    const p = ports({ isPhysicalDevice: false });

    expect(await registerForPush(p)).toEqual({ status: 'skipped', reason: 'simulator' });
    // Not merely "did not register": `getExpoPushTokenAsync` THROWS on a
    // simulator, and this runs from a root-layout effect on every cold start.
    expect(p.getPermission).not.toHaveBeenCalled();
    expect(p.getExpoToken).not.toHaveBeenCalled();
  });

  it('skips rather than throws when no EAS project is configured', async () => {
    // The state this repository is actually in until someone runs `eas init`.
    // `getExpoPushTokenAsync` throws without a project id, so the alternative
    // to this branch is a rejected promise in a layout effect on every launch.
    const p = ports({ projectId: undefined });

    expect(await registerForPush(p)).toEqual({ status: 'skipped', reason: 'no-project-id' });
    expect(p.getExpoToken).not.toHaveBeenCalled();
  });

  it('refuses to post something that is not an Expo push token', async () => {
    // A raw FCM/APNs token comes back when the project's push credentials are
    // wrong. The server's regex would 400 it; storing it would be worse — an
    // address every send fails against, silently.
    const p = ports({ getExpoToken: vi.fn(() => Promise.resolve('fY3_rawFcmTokenLookingThing')) });

    expect(await registerForPush(p)).toEqual({ status: 'skipped', reason: 'not-an-expo-token' });
    expect(p.register).not.toHaveBeenCalled();
  });

  it('reports a network failure instead of rejecting', async () => {
    const boom = new Error('Network request failed');
    const p = ports({ register: vi.fn(() => Promise.reject(boom)) });

    expect(await registerForPush(p)).toEqual({ status: 'failed', error: boom });
  });

  it('survives a permission check that throws', async () => {
    const p = ports({
      getPermission: vi.fn(() => Promise.reject(new Error('module not linked'))),
    });

    expect((await registerForPush(p)).status).toBe('failed');
  });

  it('omits the optional fields rather than sending empty ones', async () => {
    // `app_version` is `.optional()` on the server, not `.nullable()`, and an
    // empty string would fail nothing but would store a blank where a version
    // belongs — which reads as "unknown build" in exactly the place someone
    // looks when a push did not arrive.
    const p = ports({ appVersion: null, deviceName: '   ' });

    await registerForPush(p);

    expect(p.register).toHaveBeenCalledWith({ expo_token: TOKEN, platform: 'android' });
  });

  it('trims a device name the server would reject', async () => {
    const p = ports({ deviceName: 'x'.repeat(200) });

    await registerForPush(p);

    const body = vi.mocked(p.register).mock.calls[0]![0];
    expect(body.device_name).toHaveLength(120);
  });
});
