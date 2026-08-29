import { Link } from 'react-router-dom';
import { Card } from '@installment/ui';
import { ChevronRight } from 'lucide-react';
import { SECONDARY } from '../components/app-shell';
import { PageHeader } from '../components/page-header';

/**
 * The phone's overflow. Everything here is in the desktop sidebar too — this
 * page exists only because a bottom tab bar stops being navigation somewhere
 * around the fifth cell, and truncating "Settlements" to "Settle…" is worse
 * than one more tap.
 */
export function MorePage() {
  return (
    <div className="space-y-6 lg:hidden">
      <PageHeader title="More" />
      <Card className="divide-y divide-border">
        {SECONDARY.map(({ to, label, icon: Icon, hint }) => (
          <Link key={to} to={to} className="flex items-center gap-3 p-4 hover:bg-muted">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{label}</span>
              {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
