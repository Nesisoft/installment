import { describe, expect, it } from 'vitest';
import { standInDomainProblem } from './standin-domain.check';

const failing = (code: string) => async () => {
  throw Object.assign(new Error(code), { code });
};

describe('standInDomainProblem', () => {
  it('passes a domain that publishes a null MX', async () => {
    expect(
      await standInDomainProblem('customers.ejua.gh', async () => [{ exchange: '', priority: 0 }]),
    ).toBeNull();
    expect(
      await standInDomainProblem('customers.ejua.gh', async () => [{ exchange: '.', priority: 0 }]),
    ).toBeNull();
  });

  it('flags a domain nobody has registered', async () => {
    // ejua.gh itself returned NXDOMAIN when this check was written.
    const problem = await standInDomainProblem('customers.ejua.gh', failing('ENOTFOUND'));
    expect(problem).toMatch(/does not exist/);
    expect(problem).toMatch(/MX 0 \./);
  });

  it('flags a domain with no MX record', async () => {
    expect(await standInDomainProblem('customers.ejua.gh', failing('ENODATA'))).toMatch(
      /no MX record/,
    );
  });

  it('flags a domain that accepts mail', async () => {
    const problem = await standInDomainProblem('customers.ejua.gh', async () => [
      { exchange: 'mx1.mail.example', priority: 10 },
    ]);
    expect(problem).toMatch(/accepts mail \(MX mx1\.mail\.example\)/);
  });

  it('says nothing when the resolver itself fails', async () => {
    // A timeout is about the network, not the domain.
    expect(await standInDomainProblem('customers.ejua.gh', failing('ETIMEOUT'))).toBeNull();
  });
});
