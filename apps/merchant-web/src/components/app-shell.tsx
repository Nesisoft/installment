import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { Button, cn } from '@installment/ui';
import {
  CalendarClock,
  FileText,
  LayoutDashboard,
  LogOut,
  Receipt,
  ShoppingBag,
  Store,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useMerchantProfile } from '../lib/merchant-api';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  // Orders and Plans are separate on purpose: an order is a thing somebody
  // bought and the seller has to send; a plan is the instalment agreement the
  // engine runs against it. One nav entry covering both is how the fulfilment
  // queue ended up unreachable.
  { to: '/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/plans', label: 'Plans', icon: CalendarClock },
  { to: '/settlements', label: 'Settlements', icon: Wallet },
  { to: '/statements', label: 'Statements', icon: FileText },
  { to: '/templates', label: 'Templates', icon: Receipt },
];

/**
 * Responsive shell: a left sidebar on desktop (lg+) and a fixed bottom tab bar
 * on phones. One layout renders well on both — the merchant runs their store
 * from a phone or a counter PC.
 */
export function AppShell() {
  const { logout } = useAuth();
  const profile = useMerchantProfile();
  const name = profile.data?.business_name ?? 'Merchant';

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5 font-semibold text-primary">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Store className="size-4" />
          </span>
          <span className="truncate">{name}</span>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <Button variant="ghost" className="w-full justify-start" onClick={logout}>
            <LogOut className="size-4" />
            Sign out
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile top bar */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 lg:hidden">
          <div className="flex min-w-0 items-center gap-2 font-semibold text-primary">
            <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Store className="size-4" />
            </span>
            <span className="truncate">{name}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </header>

        <main className="flex-1 p-4 pb-24 md:p-8 lg:pb-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom tab bar. Six entries at 390px leave ~65px each, so the
          labels are a size down and centred in their own cell — at the shell's
          original five they ran into one another. */}
      <nav className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-6 border-t border-border bg-card lg:hidden">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              cn(
                'flex min-w-0 flex-col items-center gap-1 px-0.5 py-2 text-[10px] font-medium leading-tight transition-colors',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            <Icon className="size-5 shrink-0" />
            <span className="w-full truncate text-center">{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
