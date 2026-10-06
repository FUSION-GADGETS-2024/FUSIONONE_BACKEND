import { createBrowserRouter, Navigate } from 'react-router'
import {
  RequireAppAccess,
  RedirectIfAuthed,
  RequireEmailUnverified,
  RequireNoAccess,
  RequireBlocked,
  RequireOwnerSetup,
  RequireProfileSetup,
} from './guards'
import AppShell from './AppShell'
import RootProviders from './RootProviders'
import NotFound from './NotFound'
import LoginPage from '@/pages/auth/LoginPage'
import ForgotPasswordPage from '@/pages/auth/ForgotPasswordPage'
import SetPasswordPage from '@/pages/auth/SetPasswordPage'
import VerifyEmailPage from '@/pages/auth/VerifyEmailPage'
import NoAccessPage from '@/pages/auth/NoAccessPage'
import BlockedPage from '@/pages/auth/BlockedPage'
import SetupStorePage from '@/pages/auth/SetupStorePage'
import ProfileSetupPage from '@/pages/auth/ProfileSetupPage'
import DashboardPage from '@/pages/dashboard/DashboardPage'
import SalesPage from '@/pages/sales/SalesPage'
import NewSalePage from '@/pages/sales/NewSalePage'
import SaleDetailPage from '@/pages/sales/SaleDetailPage'
import EditSalePage from '@/pages/sales/EditSalePage'
import PurchasesPage from '@/pages/purchases/PurchasesPage'
import NewPurchasePage from '@/pages/purchases/NewPurchasePage'
import PurchaseDetailPage from '@/pages/purchases/PurchaseDetailPage'
import ProformasPage from '@/pages/proformas/ProformasPage'
import NewProformaPage from '@/pages/proformas/NewProformaPage'
import ProformaDetailPage from '@/pages/proformas/ProformaDetailPage'
import EditProformaPage from '@/pages/proformas/EditProformaPage'
import PaymentsPage from '@/pages/payments/PaymentsPage'
import MessagesPage from '@/pages/messages/MessagesPage'
import PartiesPage from '@/pages/parties/PartiesPage'
import PartyDetailPage from '@/pages/parties/PartyDetailPage'
import AccountsPage from '@/pages/accounts/AccountsPage'
import ExchangePage from '@/pages/exchange/ExchangePage'
import InventoryPage from '@/pages/inventory/InventoryPage'
import FinancialYearPage from '@/pages/financial-year/FinancialYearPage'
import SettingsPage from '@/pages/settings/SettingsPage'
import WhatsAppTemplatesPage from '@/pages/settings/WhatsAppTemplatesPage'
import ProfilePage from '@/pages/profile/ProfilePage'

/**
 * Route map.
 *
 *   /                        → redirect to /home
 *   /login                   → public (authenticated users routed by state)
 *   /forgot-password         → public (password-reset initiation)
 *   /set-password            → invitation + recovery password setup —
 *                              deliberately OUTSIDE RequireAppAccess; owns
 *                              its own ISOLATED setup client (token_hash +
 *                              verifyOtp, in-memory session, no application
 *                              session involvement)
 *   /verify-email            → EMAIL_UNVERIFIED state
 *   /no-access               → authenticated + verified + no authorized
 *                              application user (terminal, sign out)
 *   /blocked                 → owner-blocked account (terminal, sign out —
 *                              never onboarding, never a store problem)
 *   /profile-setup           → personal profile completion (normal auth
 *                              session; authorized users missing their
 *                              display_name — a post-auth gate, outside
 *                              the AppShell, before store onboarding)
 *   /setup-store             → owner-only store setup wizard (/onboarding
 *                              redirects here — old URL preserved)
 *   /home … /settings, /profile → protected, rendered inside the AppShell
 *                              (/messages = the user-facing view over the
 *                              durable message system; /delivery redirects
 *                              there permanently — old URL preserved;
 *                              /settings/whatsapp/templates = the dedicated
 *                              WhatsApp Templates page — its own focused
 *                              destination, not a third Settings tab)
 */
export const router = createBrowserRouter([
  { path: '/', element: <Navigate to="/home" replace /> },
  {
    element: <RootProviders />,
    children: [
      {
        element: <RedirectIfAuthed />,
        children: [{ path: 'login', element: <LoginPage /> }],
      },
      // Public auth-setup routes: reachable with or without a session; the
      // pages own their own (token/session) handling.
      { path: 'forgot-password', element: <ForgotPasswordPage /> },
      { path: 'set-password', element: <SetPasswordPage /> },
      {
        element: <RequireEmailUnverified />,
        children: [{ path: 'verify-email', element: <VerifyEmailPage /> }],
      },
      {
        element: <RequireNoAccess />,
        children: [{ path: 'no-access', element: <NoAccessPage /> }],
      },
      {
        element: <RequireBlocked />,
        children: [{ path: 'blocked', element: <BlockedPage /> }],
      },
      // Personal profile completion — the post-auth gate. Uses the NORMAL
      // application session (never the setup client); reachable only for an
      // authorized user whose display_name is missing; deliberately outside
      // the AppShell so no app provider (financial year, WhatsApp) mounts.
      {
        element: <RequireProfileSetup />,
        children: [{ path: 'profile-setup', element: <ProfileSetupPage /> }],
      },
      // Old setup URL — one permanent redirect, never a second wizard.
      { path: 'onboarding', element: <Navigate to="/setup-store" replace /> },
      {
        element: <RequireOwnerSetup />,
        children: [{ path: 'setup-store', element: <SetupStorePage /> }],
      },
      {
        element: <RequireAppAccess />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: 'home', element: <DashboardPage /> },
              { path: 'sales', element: <SalesPage /> },
              { path: 'sales/new', element: <NewSalePage /> },
              { path: 'sales/:id', element: <SaleDetailPage /> },
              { path: 'sales/:id/edit', element: <EditSalePage /> },
              { path: 'purchases', element: <PurchasesPage /> },
              { path: 'purchases/new', element: <NewPurchasePage /> },
              { path: 'purchases/:id', element: <PurchaseDetailPage /> },
              { path: 'proformas', element: <ProformasPage /> },
              { path: 'proformas/new', element: <NewProformaPage /> },
              { path: 'proformas/:id', element: <ProformaDetailPage /> },
              { path: 'proformas/:id/edit', element: <EditProformaPage /> },
              { path: 'payments', element: <PaymentsPage /> },
              { path: 'messages', element: <MessagesPage /> },
              // Old Messages URL — one permanent redirect, never a second page.
              { path: 'delivery', element: <Navigate to="/messages" replace /> },
              { path: 'parties', element: <PartiesPage /> },
              { path: 'parties/:id', element: <PartyDetailPage /> },
              { path: 'accounts', element: <AccountsPage /> },
              { path: 'exchange', element: <ExchangePage /> },
              { path: 'inventory', element: <InventoryPage /> },
              { path: 'financial-year', element: <FinancialYearPage /> },
              { path: 'settings', element: <SettingsPage /> },
              { path: 'settings/whatsapp/templates', element: <WhatsAppTemplatesPage /> },
              { path: 'profile', element: <ProfilePage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
])
