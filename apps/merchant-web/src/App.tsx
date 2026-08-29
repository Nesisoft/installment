import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { ProtectedRoute } from './components/protected-route';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { DashboardPage } from './pages/dashboard';
import { OrdersListPage } from './pages/orders/list';
import { OrderDetailPage } from './pages/orders/detail';
import { PlansListPage } from './pages/plans/list';
import { PlanDetailPage } from './pages/plans/detail';
import { SettlementsPage } from './pages/settlements';
import { StatementsPage } from './pages/statements';
import { PlanTemplatesPage } from './pages/plan-templates';

export function App() {
  const { isAuthenticated } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={isAuthenticated ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/orders" element={<OrdersListPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/plans" element={<PlansListPage />} />
          <Route path="/plans/:id" element={<PlanDetailPage />} />
          <Route path="/settlements" element={<SettlementsPage />} />
          <Route path="/statements" element={<StatementsPage />} />
          <Route path="/templates" element={<PlanTemplatesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
