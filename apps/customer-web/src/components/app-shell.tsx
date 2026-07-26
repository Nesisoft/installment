import { Outlet } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { Button } from '@installment/ui';
import { LogOut, Wallet } from 'lucide-react';

export function AppShell() {
  const { logout, session } = useAuth();

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-card/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-md items-center justify-between px-4">
          <div className="flex items-center gap-2 font-semibold text-primary">
            <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Wallet className="size-4" />
            </span>
            Installment
          </div>
          <Button variant="ghost" size="sm" onClick={logout} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-md px-4 py-6">
        <Outlet />
      </main>
      {session ? (
        <footer className="mx-auto max-w-md px-4 pb-6 text-center text-xs text-muted-foreground">
          Signed in as customer
        </footer>
      ) : null}
    </div>
  );
}
