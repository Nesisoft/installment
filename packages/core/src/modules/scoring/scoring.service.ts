import { desc, eq } from 'drizzle-orm';
import { schema, type Database } from '@installment/db';
import { runInTransaction } from '../../shared/event-bus/transaction';
import { ScoringEngine } from './scoring-engine';
import { FeatureCollector } from './feature-collector';
import type { FeatureVector, ScoringDecision } from './types';
import { toCreditProfileValues, toRecordDecisionInput } from './decision-mapping';
import { ScoringDecisionNotFoundError } from './errors';
import {
  ApplicationsService,
  type Application,
  type ApplicationActor,
} from '../applications/applications.service';

const cp = schema.credit_profiles;
const pt = schema.plan_templates;

export type CreditProfile = typeof schema.credit_profiles.$inferSelect;

export interface ScoreResult {
  decision: ScoringDecision;
  application: Application;
  creditProfile: CreditProfile;
}

/**
 * Orchestrates a credit decision: collect signals → run the pure engine →
 * persist an immutable credit_profiles row → transition the application. The
 * profile insert and the application transition share one transaction, so a
 * decision is never recorded without its evidence (and re-scoring a terminal
 * application rolls the whole attempt back, leaving the original row intact).
 */
export class ScoringService {
  constructor(
    private readonly db: Database,
    private readonly collector: FeatureCollector,
    private readonly engine: ScoringEngine,
    private readonly applications: ApplicationsService,
  ) {}

  async scoreApplication(applicationId: string, actor: ApplicationActor): Promise<ScoreResult> {
    const { app, features } = await this.buildFeatures(applicationId);
    const decision = this.engine.score(features);

    return runInTransaction(this.db, async (tx) => {
      const inserted = await tx
        .insert(cp)
        .values(toCreditProfileValues(app.customer_id, app.id, decision))
        .returning();
      const creditProfile = inserted[0];
      if (!creditProfile) throw new Error('credit_profiles insert returned no row');

      const application = await this.applications.applyDecision(
        tx,
        applicationId,
        toRecordDecisionInput(decision),
        actor,
      );
      return { decision, application, creditProfile };
    });
  }

  /** Score without persisting — try the live signals against the engine. */
  async dryRun(applicationId: string): Promise<ScoringDecision> {
    const { features } = await this.buildFeatures(applicationId);
    return this.engine.score(features);
  }

  /** Score an arbitrary feature vector (rule playground). */
  scoreFeatures(features: FeatureVector, now?: Date): ScoringDecision {
    return this.engine.score(features, now);
  }

  /** The most recent decision recorded for an application, with rule breakdown. */
  async latestDecision(applicationId: string): Promise<CreditProfile> {
    const rows = await this.db
      .select()
      .from(cp)
      .where(eq(cp.application_id, applicationId))
      .orderBy(desc(cp.decided_at))
      .limit(1);
    const row = rows[0];
    if (!row) throw new ScoringDecisionNotFoundError(applicationId);
    return row;
  }

  private async buildFeatures(
    applicationId: string,
  ): Promise<{ app: Application; features: FeatureVector }> {
    const app = await this.applications.get(applicationId);
    const planRows = await this.db
      .select({
        min: pt.min_amount_pesewas,
        max: pt.max_amount_pesewas,
        downPaymentBps: pt.down_payment_bps,
      })
      .from(pt)
      .where(eq(pt.id, app.plan_template_id))
      .limit(1);
    const plan = planRows[0];
    if (!plan) throw new Error(`plan template ${app.plan_template_id} not found`);

    const request: FeatureVector['request'] = {
      orderAmountGhs: app.order_amount_pesewas / 100,
      merchantCategory: app.merchant_category,
      planTemplateId: app.plan_template_id,
      planMinGhs: plan.min / 100,
      planMaxGhs: plan.max / 100,
      downPaymentBps: plan.downPaymentBps,
    };
    const features = await this.collector.collect(app.customer_id, request);
    return { app, features };
  }
}
