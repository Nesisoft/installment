import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPAIR_QUERIES } from './queries';

/**
 * The runbook's copies of the repair queries are the ones an operator pastes
 * into psql against production. A copy that drifted from the code would report
 * something the tool does not — so the copies are checked, not trusted.
 */
describe('repair queries', () => {
  // Walk up to the workspace root rather than counting '..' from __dirname,
  // which vitest's transform does not reliably provide.
  function workspaceRoot(): string {
    let dir = process.cwd();
    for (let i = 0; i < 8; i++) {
      try {
        if (statSync(join(dir, 'pnpm-workspace.yaml')).isFile()) return dir;
      } catch {
        /* keep walking */
      }
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`could not locate the workspace root from ${process.cwd()}`);
  }

  const runbook = readFileSync(join(workspaceRoot(), 'docs/runbooks/money-repairs.md'), 'utf8');

  it.each(Object.entries(REPAIR_QUERIES))('the runbook carries %s exactly', (_name, text) => {
    expect(runbook).toContain(text);
  });

  it.each(Object.entries(REPAIR_QUERIES))('%s only reads', (_name, text) => {
    const statements = text.split(';').filter((s) => s.trim());
    expect(statements).toHaveLength(1);
    expect(text).toMatch(/^(WITH|SELECT)\b/);
    expect(text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|GRANT)\b/i);
  });
});
