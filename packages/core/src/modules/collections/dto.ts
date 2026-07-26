import { z } from 'zod';

const uuid = z.string().uuid();

export const listCasesSchema = z.object({
  stage: z
    .enum([
      'soft_reminder',
      'firm_reminder',
      'restriction_warning',
      'agent_assigned',
      'field_visit',
      'legal_threat',
      'write_off',
    ])
    .optional(),
  /** true (default) → open cases only; false → closed only; omit for both. */
  open: z.boolean().optional().default(true),
  assigned_agent_id: uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
  offset: z.number().int().min(0).default(0),
});
export type ListCasesInput = z.infer<typeof listCasesSchema>;

/** Manual agent action types — `stage_changed` is system-only (sweep). */
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

export const assignCaseSchema = z.object({
  agent_id: uuid,
});
export type AssignCaseInput = z.infer<typeof assignCaseSchema>;

/**
 * Manual close resolutions only. `defaulted` / `written_off` are reached through
 * the dunning write-off path (CollectionsService.defaultWrittenOffCases), not a
 * manual close, so they are intentionally excluded here.
 */
export const closeCaseSchema = z.object({
  resolution: z.enum(['paid', 'waived', 'restructured']),
  notes: z.string().trim().max(2000).optional(),
});
export type CloseCaseInput = z.infer<typeof closeCaseSchema>;
