import { customType } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL `citext` (case-insensitive text). drizzle-kit's introspector
 * cannot parse the `citext` type, so generated columns are rewritten to use
 * this custom type by scripts/fix-introspect.ts. Behaves like text in JS.
 */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});
