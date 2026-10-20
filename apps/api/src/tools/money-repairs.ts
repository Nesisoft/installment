import { createDb } from '@installment/db';
import {
  AuditLogger,
  LedgerService,
  Money,
  MoneyRepairsService,
  PasswordService,
  PlanCashLedger,
  REPAIR_QUERIES,
  SettlementService,
  UsersService,
  type MoneyRepairReport,
  type RepairActor,
} from '@installment/core';

/**
 * Finds, and on request corrects, what four fixed bugs left wrong in the data.
 *
 * Reports by default and changes nothing. Corrections need `--yes`, as
 * `db:clean:fixtures` does, and a named operator, as `create-admin` does: every
 * correction is written to the audit log against a real staff account, never a
 * shared or system one. `docs/runbooks/money-repairs.md` says what each finding
 * means and what to tell the people it affected.
 *
 *   pnpm repair:money                                   report (read-only)
 *   pnpm repair:money -- --json                         the same, as JSON
 *   pnpm repair:money -- sql                            the queries, for psql
 *
 *   REPAIR_OPERATOR_EMAIL=ops@… pnpm repair:money -- apply-defaults [--plan <id>] [--yes]
 *   REPAIR_OPERATOR_EMAIL=ops@… pnpm repair:money -- apply-reversals [--reference <ref>] [--yes]
 *   REPAIR_OPERATOR_EMAIL=ops@… REPAIR_REASON='…' \
 *     pnpm repair:money -- reopen-case <case-id> [--yes]
 *
 * Without `--yes` an apply command lists what it would correct and stops.
 */

const USAGE = `Usage:
  pnpm repair:money [-- --json]
  pnpm repair:money -- sql
  REPAIR_OPERATOR_EMAIL=<staff email> pnpm repair:money -- apply-defaults [--plan <id>] [--yes]
  REPAIR_OPERATOR_EMAIL=<staff email> pnpm repair:money -- apply-reversals [--reference <ref>] [--yes]
  REPAIR_OPERATOR_EMAIL=<staff email> REPAIR_REASON='<why>' pnpm repair:money -- reopen-case <case-id> [--yes]`;

const ghs = (pesewas: number): string => Money.fromPesewas(pesewas).format();

/**
 * A `--name value` or `--name=value` argument. Present without a value is an
 * error, not "no filter": `--plan` with its id lost to a shell typo would
 * otherwise widen `--yes` from one plan to every one.
 */
function flag(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline !== undefined) {
    const value = inline.slice(name.length + 1).trim();
    if (!value) refuse(`${name}= needs a value.`);
    return value;
  }
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith('--')) refuse(`${name} needs a value.`);
  return value;
}

const SWITCHES = new Set(['--yes', '--json']);
const VALUED = ['--plan', '--reference'];

/**
 * The command and its operand, with every flag accounted for. An unknown flag
 * is refused rather than ignored: `--yse` silently dropped would turn a
 * correction into a dry run nobody noticed, and a misspelt filter into no
 * filter at all.
 */
function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--')) out.push(a);
    else if (SWITCHES.has(a) || VALUED.some((v) => a.startsWith(`${v}=`))) continue;
    else if (VALUED.includes(a)) i += 1;
    else refuse(`Unknown option "${a}".`);
  }
  return out;
}

function refuse(message: string): never {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(1);
}

/**
 * Runs one correction per target, carrying on past a refusal. A refused
 * correction wrote nothing (its transaction rolled back); stopping there would
 * strand every target after it, and a re-run would meet the same one first.
 */
async function eachTarget<T>(
  targets: T[],
  label: (t: T) => string,
  run: (t: T) => Promise<string>,
): Promise<number> {
  let refused = 0;
  for (const t of targets) {
    try {
      console.log(`  ${await run(t)}`);
    } catch (err) {
      refused += 1;
      console.error(`  ${label(t)}: REFUSED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (refused)
    console.error(`\n${refused} refused; nothing was written for those. See the runbook.`);
  return refused;
}

function printReport(r: MoneyRepairReport): void {
  console.log(`Oversized defaults (#114): ${r.oversizedDefaults.length}`);
  for (const d of r.oversizedDefaults) {
    console.log(
      `  plan ${d.customerPlanId}  ${d.businessModel}  merchant ${d.merchantId}  defaulted ${d.defaultedAt}`,
    );
    console.log(
      `    written off ${ghs(d.writtenOffPesewas)}, fronted ${ghs(d.shouldWriteOffPesewas)}; give back: ` +
        `reserve ${ghs(d.correction.reserve)}, merchant ${ghs(d.correction.merchant)}, pool ${ghs(d.correction.pool)}`,
    );
  }
  console.log(`\nIgnored payout reversals (#111): ${r.ignoredPayoutReversals.length}`);
  for (const p of r.ignoredPayoutReversals) {
    console.log(
      `  ${p.reference}  merchant ${p.merchantId}  ${ghs(p.amountPesewas)}  reversed ${p.reversedAt}` +
        (p.gatewayResponse ? `  "${p.gatewayResponse}"` : ''),
    );
  }
  console.log(`\nStranded collections cases (#110): ${r.strandedCollectionsCases.length}`);
  for (const c of r.strandedCollectionsCases) {
    const owed = c.amountDuePesewas + c.lateFeePesewas - c.amountPaidPesewas;
    console.log(
      `  case ${c.caseId}  closed as ${c.resolution ?? '—'} ${c.closedAt}  ${c.customerName} ${c.customerPhone}`,
    );
    console.log(
      `    instalment ${c.sequenceNumber} due ${c.dueDate}, ${ghs(owed)} unpaid` +
        (c.closeNote ? `; note at close: "${c.closeNote}"` : ''),
    );
  }
  console.log(`\nUnresolved payment attempts over an hour old (#106, drains on its own):`);
  if (r.unresolvedPaymentAttempts.length === 0) console.log('  none');
  for (const a of r.unresolvedPaymentAttempts) {
    console.log(`  ${a.status}: ${a.attempts}, oldest ${a.oldest}`);
  }
}

async function operator(users: UsersService): Promise<RepairActor> {
  const email = (process.env.REPAIR_OPERATOR_EMAIL ?? '').trim();
  if (!email) {
    console.error('REPAIR_OPERATOR_EMAIL is required: corrections are recorded against a person.');
    process.exit(1);
  }
  const user = await users.findByEmail(email);
  if (!user || user.user_type !== 'admin') {
    console.error(`No admin account with email ${email}. Create one with pnpm create-admin.`);
    process.exit(1);
  }
  return { actorId: user.id, actorType: 'admin' };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command = 'report', operand] = positionals(args);
  const yes = args.includes('--yes');

  if (command === 'sql') {
    for (const [name, text] of Object.entries(REPAIR_QUERIES)) {
      console.log(`-- ${name}\n${text};\n`);
    }
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const { db, pool } = createDb({ connectionString });
  try {
    const audit = new AuditLogger();
    const ledger = new LedgerService(db);
    const settlement = new SettlementService(db, ledger, audit, {
      async initiateTransfer() {
        throw new Error('money-repairs never sends a transfer');
      },
    });
    const repairs = new MoneyRepairsService(
      db,
      ledger,
      audit,
      settlement,
      new PlanCashLedger(ledger),
    );
    const users = new UsersService(db, audit, new PasswordService());

    switch (command) {
      case 'report': {
        const report = await repairs.report();
        if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
        else printReport(report);
        return;
      }

      case 'apply-defaults': {
        const only = flag(args, '--plan');
        const targets = (await repairs.findOversizedDefaults()).filter(
          (d) => !only || d.customerPlanId === only,
        );
        console.log(`${targets.length} oversized default(s)${only ? ` for plan ${only}` : ''}.`);
        if (!yes) {
          printReport({
            oversizedDefaults: targets,
            ignoredPayoutReversals: [],
            strandedCollectionsCases: [],
            unresolvedPaymentAttempts: [],
          });
          console.log('\nNothing written. Re-run with --yes to correct these.');
          return;
        }
        const actor = await operator(users);
        const refused = await eachTarget(
          targets,
          (d) => `plan ${d.customerPlanId}`,
          async (d) => {
            const done = await repairs.correctOversizedDefault(d.customerPlanId, actor);
            return done
              ? `corrected plan ${d.customerPlanId}: merchant +${ghs(done.correction.merchant)}, reserve +${ghs(done.correction.reserve)}, pool +${ghs(done.correction.pool)}`
              : `plan ${d.customerPlanId}: nothing to correct (already done?)`;
          },
        );
        if (refused) process.exitCode = 1;
        return;
      }

      case 'apply-reversals': {
        const only = flag(args, '--reference');
        const targets = (await repairs.findIgnoredPayoutReversals()).filter(
          (p) => !only || p.reference === only,
        );
        console.log(`${targets.length} ignored reversal(s)${only ? ` for ${only}` : ''}.`);
        for (const p of targets) {
          console.log(`  ${p.reference}  merchant ${p.merchantId}  ${ghs(p.amountPesewas)}`);
        }
        if (!yes) {
          console.log('\nNothing written. Re-run with --yes to apply these.');
          return;
        }
        const actor = await operator(users);
        const refused = await eachTarget(
          targets,
          (p) => p.reference,
          async (p) => {
            const done = await repairs.applyIgnoredPayoutReversal(p.reference, actor);
            return done
              ? `applied ${p.reference}: merchant ${p.merchantId} is owed ${ghs(p.amountPesewas)} again`
              : `${p.reference}: nothing to apply (already done?)`;
          },
        );
        if (refused) process.exitCode = 1;
        return;
      }

      case 'reopen-case': {
        const caseId = operand;
        const reason = (process.env.REPAIR_REASON ?? '').trim();
        if (!caseId || !reason) refuse('reopen-case needs a case id and REPAIR_REASON.');
        const target = (await repairs.findStrandedCollectionsCases()).find(
          (c) => c.caseId === caseId,
        );
        if (!target) {
          console.error(`Case ${caseId} is not on the stranded list; nothing to reopen.`);
          process.exit(1);
        }
        printReport({
          oversizedDefaults: [],
          ignoredPayoutReversals: [],
          strandedCollectionsCases: [target],
          unresolvedPaymentAttempts: [],
        });
        if (!yes) {
          console.log('\nNothing written. Re-run with --yes to reopen it.');
          return;
        }
        await repairs.reopenStrandedCase(caseId, reason, await operator(users));
        console.log(
          `\nReopened case ${caseId} at the first reminder stage. Record a payment or waive it from the admin console.`,
        );
        return;
      }

      default:
        refuse(`Unknown command "${command}".`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
