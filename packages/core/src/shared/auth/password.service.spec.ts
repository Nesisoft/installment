import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service';

describe('PasswordService', () => {
  // Low cost keeps the suite fast; production uses the default 12.
  const svc = new PasswordService(4);

  it('hashes and verifies a correct password', async () => {
    const hash = await svc.hash('correct horse battery staple');
    expect(hash).not.toBe('correct horse battery staple');
    expect(await svc.verify('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await svc.hash('s3cret');
    expect(await svc.verify('wrong', hash)).toBe(false);
  });

  it('produces a different hash each time (salted)', async () => {
    const a = await svc.hash('same');
    const b = await svc.hash('same');
    expect(a).not.toBe(b);
    expect(await svc.verify('same', a)).toBe(true);
    expect(await svc.verify('same', b)).toBe(true);
  });

  it('returns false for empty inputs and throws on hashing an empty password', async () => {
    expect(await svc.verify('', 'whatever')).toBe(false);
    expect(await svc.verify('x', '')).toBe(false);
    await expect(svc.hash('')).rejects.toThrow(/required/);
  });
});
