import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { Button, cn } from '@installment/ui';
import {
  FileText,
  LayoutDashboard,
  LogOut,
  Receipt,
  Store,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/orders', label: 'Orders', icon: Store },
  { to: '/settlements', label: 'Settlements', icon: Wallet },
  { to: '/statements', label: 'Statements', icon: FileText },
  { to: '/templates', label: 'Plan templates', icon: Receipt },
];

export function AppShell() {
  const { logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card md:flex">
        <div className="flex h-14 items-center gap-2 border-b border-border px-5 font-semibold text-primary">
          <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Store className="size-4" />
          </span>
          Merchant
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
        <header className="flex h-14 items-center justify-between border-b border-border bg-card px-4 md:hidden">
          <span className="font-semibold text-primary">Merchant</span>
          <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </header>
        <main className="flex-1 p-4 md:p-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
