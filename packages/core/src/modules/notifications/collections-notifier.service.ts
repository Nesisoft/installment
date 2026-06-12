import { Money } from '../../shared/money/money';
import type { CustomerPlansService } from '../schedules/customer-plans.service';
import type { CustomersService } from '../customers/customers.service';
import type { CollectionsStage } from '../collections/stage-policy';
import type { NotificationService } from './notification.service';
import type { NotificationTemplateId } from './notification-templates';

/** Stages that carry a customer-facing dunning SMS; others (field/agent/etc.) are operational. */
const STAGE_TEMPLATE: Partial<Record<CollectionsStage, NotificationTemplateId>> = {
  soft_reminder: 'collections_soft_reminder',
  firm_reminder: 'collections_firm_reminder',
  restriction_warning: 'collections_restriction_warning',
  legal_threat: 'collections_legal_threat',
};

/**
 * Fires the dunning SMS when a case enters a customer-facing stage.
 * CollectionsService takes this as an optional port and calls it after a
 * successful stage transition. Best-effort — every method swallows errors so a
 * dropped SMS never blocks the case advance.
 */
export class CollectionsNotifierService {
  constructor(
    private readonly plans: CustomerPlansService,
    private readonly customers: CustomersService,
    private readonly notifications: NotificationService,
  ) {}

  async notifyStageEntered(args: {
    customerPlanId: string;
    scheduleId: string | null;
    stage: CollectionsStage;
  }): Promise<void> {
    const templateId = STAGE_TEMPLATE[args.stage];
    if (!templateId) return; // operational stage — no customer SMS

    try {
      const plan = await this.plans.get(args.customerPlanId);
      const customer = await this.customers.get(plan.customer_id);
      if (!customer.momo_phone) return;

      // Outstanding plan balance is the right "ask the customer to pay" number.
      const amount = plan.outstanding_pesewas;
      await this.notifications.sendToCustomer({
        customerId: customer.id,
        toAddress: customer.momo_phone,
        templateId,
        variables: {
          name: customer.first_name,
          amount: Money.fromPesewas(amount).format('').trim(),
        },
      });
    } catch {
      // best-effort
    }
  }
}
