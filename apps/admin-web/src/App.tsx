import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@installment/web-kit';
import { ProtectedRoute } from './components/protected-route';
import { AppShell } from './components/app-shell';
import { LoginPage } from './pages/login';
import { DashboardPage } from './pages/dashboard';
import { PlaceholderPage } from './pages/placeholder';
import { TelcoHealthPage } from './pages/telco-health';
import { ApplicationsQueuePage } from './pages/applications/queue';
import { ApplicationDetailPage } from './pages/applications/detail';
import { MerchantsListPage } from './pages/merchants/list';
import { MerchantNewPage } from './pages/merchants/new';
import { MerchantDetailPage } from './pages/merchants/detail';
import { CustomersListPage } from './pages/customers/list';
import { CustomerNewPage } from './pages/customers/new';
import { CustomerDetailPage } from './pages/customers/detail';
import { PlanTemplatesListPage } from './pages/plan-templates/list';
import { PlanTemplateEditorPage } from './pages/plan-templates/editor';
import { CollectionsListPage } from './pages/collections/list';
import { CollectionsDetailPage } from './pages/collections/detail';
import { PlanLookupPage } from './pages/plans/lookup';
import { PlanDetailPage } from './pages/plans/detail';
import { OrdersListPage } from './pages/orders/list';
import { OrderDetailPage } from './pages/orders/detail';
import { RefundsPage } from './pages/refunds/list';
import { LedgerPage } from './pages/ledger';

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

          <Route path="/applications" element={<ApplicationsQueuePage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />

          <Route path="/plans" element={<PlanLookupPage />} />
          <Route path="/plans/:id" element={<PlanDetailPage />} />

          <Route path="/orders" element={<OrdersListPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          <Route path="/refunds" element={<RefundsPage />} />
          <Route path="/ledger" element={<LedgerPage />} />

          <Route path="/merchants" element={<MerchantsListPage />} />
          <Route path="/merchants/new" element={<MerchantNewPage />} />
          <Route path="/merchants/:id" element={<MerchantDetailPage />} />

          <Route path="/customers" element={<CustomersListPage />} />
          <Route path="/customers/new" element={<CustomerNewPage />} />
          <Route path="/customers/:id" element={<CustomerDetailPage />} />

          <Route path="/templates" element={<PlanTemplatesListPage />} />
          <Route path="/templates/new" element={<PlanTemplateEditorPage />} />
          <Route path="/templates/:id" element={<PlanTemplateEditorPage />} />

          <Route path="/collections" element={<CollectionsListPage />} />
          <Route path="/collections/:id" element={<CollectionsDetailPage />} />
          <Route
            path="/scoring"
            element={
              <PlaceholderPage
                title="Scoring playground"
                note="Per-application scoring (dry-run + persist) lives on each application's detail page, under Credit scoring. A standalone feature-vector playground can be added here next."
              />
            }
          />
          <Route path="/telco-health" element={<TelcoHealthPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
