import bcrypt from 'bcryptjs';

/** bcrypt password hashing for staff/merchant credentials. */
export class PasswordService {
  constructor(private readonly rounds = 12) {}

  async hash(plain: string): Promise<string> {
    if (!plain) throw new Error('PasswordService.hash: password is required');
    return bcrypt.hash(plain, this.rounds);
  }

  verify(plain: string, hash: string): Promise<boolean> {
    if (!plain || !hash) return Promise.resolve(false);
    return bcrypt.compare(plain, hash);
  }
}
