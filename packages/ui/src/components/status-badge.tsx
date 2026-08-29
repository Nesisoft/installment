import { Badge, type BadgeTone } from './badge';
import { cn } from '../lib/cn';

/**
 * Maps the backend's many status enums to a small set of visual tones.
 * Unknown values fall back to a neutral muted badge.
 */
const TONE_BY_STATUS: Record<string, BadgeTone> = {
  // generic positive / terminal-good
  active: 'success',
  approved: 'success',
  approved_tier_2: 'success',
  paid: 'success',
  settled: 'success',
  completed: 'success',
  succeeded: 'success',
  delivered: 'success',
  sent: 'info',
  healthy: 'success',
  verified: 'success',

  // in-progress / neutral
  pending: 'muted',
  pending_kyc: 'warning',
  pending_confirmation: 'warning',
  processing: 'info',
  in_flight: 'info',
  due: 'info',
  queued: 'muted',
  initiated: 'info',
  unknown: 'muted',
  counter_offered: 'info',
  counter_offer: 'info',
  restructured: 'info',

  // order lifecycle: money in, then the fulfilment ladder
  pending_payment: 'warning',
  pending_approval: 'warning',
  financing_active: 'success',
  fulfilling: 'info',
  shipped: 'info',
  out_for_delivery: 'info',

  // needs attention
  manual_review: 'warning',
  retry_scheduled: 'warning',
  overdue: 'warning',
  degraded: 'warning',
  near_prime: 'warning',
  suspended: 'warning',
  paused: 'warning',
  restriction_warning: 'warning',
  firm_reminder: 'warning',

  // negative / terminal-bad
  declined: 'danger',
  failed: 'danger',
  payment_failed: 'danger',
  returned: 'muted',
  defaulted: 'danger',
  in_collections: 'danger',
  cancelled: 'muted',
  expired: 'muted',
  offboarded: 'muted',
  terminated: 'danger',
  bounced: 'danger',
  down: 'danger',
  subprime: 'danger',
  written_off: 'danger',
  write_off: 'danger',
  legal_threat: 'danger',
  reversed: 'danger',
  refunded: 'muted',
  waived: 'muted',

  // collections stages (informational ladder)
  soft_reminder: 'info',
  agent_assigned: 'info',
  field_visit: 'warning',

  // risk bands
  prime: 'success',
  unscorable: 'muted',
};

export function statusTone(status: string): BadgeTone {
  return TONE_BY_STATUS[status] ?? 'muted';
}

/** snake_case / lower → "Title Case". */
export function formatStatusLabel(status: string): string {
  return status
    .split('_')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export interface StatusBadgeProps {
  status: string;
  className?: string;
  /** Override the auto-detected tone. */
  tone?: BadgeTone;
  /** Override the auto-formatted label. */
  label?: string;
}

export function StatusBadge({ status, className, tone, label }: StatusBadgeProps) {
  return (
    <Badge variant={tone ?? statusTone(status)} className={cn(className)}>
      {label ?? formatStatusLabel(status)}
    </Badge>
  );
}
