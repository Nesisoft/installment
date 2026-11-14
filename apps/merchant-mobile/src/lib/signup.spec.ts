import { describe, expect, it } from 'vitest';
import { businessDetailsBody, signupPhone } from './signup';

const DETAILS = {
  businessName: 'Auntie Akos Kente',
  legalName: 'Akosua Ventures Ltd',
  email: 'Akos@Example.com ',
  password: 'kente-forever',
  tin: '',
};

describe('signupPhone', () => {
  it('accepts a number however it was typed', () => {
    expect(signupPhone('024 455 1338')).toBe('0244551338');
    expect(signupPhone('+233-24-455-1338')).toBe('+233244551338');
    expect(signupPhone('(024) 455 1338')).toBe('0244551338');
  });

  it('refuses what is not a Ghana number', () => {
    expect(signupPhone('')).toBeNull();
    expect(signupPhone('24455133')).toBeNull();
    expect(signupPhone('0244 551 33x')).toBeNull();
  });
});

describe('businessDetailsBody', () => {
  it('builds the body the API expects, without asking for what onboarding does', () => {
    const result = businessDetailsBody('ticket', DETAILS);
    expect(result).toEqual({
      ok: true,
      body: {
        signupToken: 'ticket',
        business_name: 'Auntie Akos Kente',
        legal_name: 'Akosua Ventures Ltd',
        email: 'akos@example.com',
        password: 'kente-forever',
      },
    });
  });

  it('sends a TIN only when one was typed', () => {
    const result = businessDetailsBody('ticket', { ...DETAILS, tin: ' C0012345678 ' });
    expect(result.ok && result.body.tin).toBe('C0012345678');
  });

  it('says what is wrong in plain words, one thing at a time', () => {
    expect(businessDetailsBody('ticket', { ...DETAILS, businessName: '  ' })).toEqual({
      ok: false,
      error: 'Give your shop a name.',
    });
    expect(businessDetailsBody('ticket', { ...DETAILS, password: 'short' })).toEqual({
      ok: false,
      error: 'Your password needs at least 8 characters.',
    });
    expect(businessDetailsBody('ticket', { ...DETAILS, email: 'not-an-email' })).toEqual({
      ok: false,
      error: 'That email address does not look right.',
    });
  });
});
