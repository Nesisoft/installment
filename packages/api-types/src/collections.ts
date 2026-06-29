import { z } from 'zod';
import type {
  CollectionsAction,
  CollectionsCase,
  CustomerPlan,
  InstallmentScheduleRow,
} from './domain';

export const recordActionSchema = z.object({
  action_type: z.enum([
    'sms_sent',
    'email_sent',
    'call_made',
    'visit_scheduled',
    'visit_completed',
    'note_added',
  ]),
  channel: z.string().trim().max(80).optional(),
  outcome: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export type RecordActionInput = z.infer<typeof recordActionSchema>;

export const assignCaseSchema = z.object({ agent_id: z.string().uuid() });
export type AssignCaseInput = z.infer<typeof assignCaseSchema>;

export const closeCaseSchema = z.object({
  resolution: z.enum(['paid', 'waived', 'restructured']),
  notes: z.string().trim().max(2000).optional(),
});
export type CloseCaseInput = z.infer<typeof closeCaseSchema>;

export interface CollectionsCaseDetail {
  case: CollectionsCase;
  actions: CollectionsAction[];
  plan: CustomerPlan | null;
  schedule: InstallmentScheduleRow | null;
  customer: { id: string; first_name: string; last_name: string; phone: string } | null;
}

export interface ListCasesParams {
  stage?: string;
  open?: boolean;
  assigned_agent_id?: string;
  limit?: number;
  offset?: number;
}
