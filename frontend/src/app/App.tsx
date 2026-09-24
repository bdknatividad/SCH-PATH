import React, { Component, ErrorInfo, ReactNode, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AlertCircle } from 'lucide-react';
import { AuthProvider, useAuth } from './state/AuthContext';
import { DataProvider } from './state/DataContext'; 
import { SystemDialogProvider } from './components/SystemDialog';

import { Layout } from '@/app/components/Layout';
import { LoginPage } from '@/app/components/LoginPage';
import { lazyComponent, RouteFallback } from '@/app/utils/lazyComponent';

/*
 * Every module is loaded on demand.
 *
 * The static imports that used to live here put the entire application in a
 * single chunk, so opening the login page downloaded both PDF engines and the
 * zip library as well — roughly 700 KB gzip before it could draw a username
 * field. Splitting by route means a user only pays for the module they open.
 *
 * `Layout` stays a static import on purpose: it wraps every authenticated
 * route, so it is on the critical path regardless and splitting it would only
 * add a round trip. `LoginPage` is static for the same reason — it is the first
 * thing anyone loads, so a separate chunk for it would be a request with no
 * benefit.
 */
const Dashboard = lazyComponent(() => import('@/app/components/Dashboard'), 'Dashboard');
const ChildRecords = lazyComponent(() => import('@/app/components/ChildRecords'), 'ChildRecords');
const ChildDetail = lazyComponent(() => import('@/app/components/ChildDetail'), 'ChildDetail');
const Activities = lazyComponent(() => import('@/app/components/Activities'), 'Activities');
const ActivityDetail = lazyComponent(() => import('@/app/components/ActivityDetail'), 'default');
const EvaluationForm = lazyComponent(() => import('@/app/components/EvaluationForm'), 'default');

const Assessments = lazyComponent(() => import('@/app/components/Assessments'), 'Assessments');
const AssessmentDetail = lazyComponent(() => import('@/app/components/AssessmentDetail'), 'AssessmentDetail');
const Health = lazyComponent(() => import('@/app/components/Health'), 'Health');
const AccountManagement = lazyComponent(() => import('@/app/components/AccountManagement'), 'AccountManagement');
const Reports = lazyComponent(() => import('@/app/components/Reports'), 'Reports');
const Violations = lazyComponent(() => import('@/app/components/Violations'), 'Violations');
const CourtRecords = lazyComponent(() => import('@/app/components/CourtRecords'), 'CourtRecords');
const SocialWorker = lazyComponent(() => import('@/app/components/SocialWorker'), 'SocialWorker');
const DocumentUpload = lazyComponent(() => import('@/app/components/DocumentUpload'), 'DocumentUpload');
const Education = lazyComponent(() => import('@/app/components/Education'), 'Education');
const Tri = lazyComponent(() => import('@/app/components/Tri'), 'Tri');

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  // The stack stays in the console for whoever is debugging; it is deliberately
  // not rendered. This screen used to print `error.message` verbatim under a
  // "May Error sa Component:" heading, which put a raw exception — often a fetch
  // failure naming the API host — in front of staff as the page.
  componentDidCatch(error: Error, errorInfo: ErrorInfo) { console.error("Uncaught error:", error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6">
          <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
              <AlertCircle className="h-6 w-6 text-red-600" />
            </div>
            <h1 className="text-lg font-bold text-[#2F3E46]">Something went wrong on this page</h1>
            <p className="mt-2 text-sm leading-relaxed text-gray-600">
              The page could not be displayed. Reloading usually clears it. If it keeps happening,
              report what you were doing to the Center Head so it can be checked.
            </p>
            <button
              className="mt-6 w-full rounded-lg bg-[#2F3E46] px-4 py-2.5 text-sm font-bold text-white hover:bg-[#263440]"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const GlobalStyles = () => (
  <style>{`
    ::placeholder { color: #4b5563 !important; opacity: 1 !important; }
    [data-placeholder] { color: #4b5563 !important; opacity: 1 !important; }
  `}</style>
);

/**
 * UPDATED ProtectedRoute
 * Chine-check na nito ngayon ang module name imbes na role lang.
 */
/**
 * Module label → route, and the module gate itself, live in
 * `app/config/moduleAccess.ts` so the Dashboard can use the same facts without
 * a second copy. See that file for why.
 */
import { MODULE_ROUTES, canOpenModule, canonicalizeModules } from '@/app/config/moduleAccess';

function ProtectedRoute({ children, moduleName }: { children: React.ReactNode, moduleName?: string }) {
  const { user, loading, logout } = useAuth(); 
  const isAuthenticated = localStorage.getItem('isAuthenticated') === 'true';

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading authentication...</div>;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/" replace />;
  }

  // The gate reads the RBAC model: full-access roles pass everything, and a
  // role whose matrix grants every module passes without a special case. What
  // a caller can actually *do* on the page is still decided by the API.
  if (moduleName && !canOpenModule(user.role, user.accessibleModules, moduleName)) {
    const fallback = (user.accessibleModules || [])
      .map(module => MODULE_ROUTES[canonicalizeModules([module])[0]])
      .find(path => path && path !== window.location.pathname);

    if (fallback) {
      return <Navigate to={fallback} replace />;
    }

    // No accessible module to fall back to — show a terminal screen rather
    // than redirecting to another gated route.
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-xl font-bold text-[#2F3E46]">No module access</h1>
        <p className="max-w-md text-sm text-gray-600">
          Your account does not have access to the “{moduleName}” module.
          Please ask the Center Head to grant the module you need.
        </p>
        <button
          className="rounded bg-[#2F3E46] px-4 py-2 text-sm font-bold text-white"
          onClick={logout}
        >
          Log out
        </button>
      </div>
    );
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <AuthProvider>
      <DataProvider>
        {/* One dialog layer for the whole app, so every module's confirmations and
            outcomes look and behave the same. Mounted inside the data providers
            because the screens it serves are the ones they feed. */}
        <SystemDialogProvider>
        <GlobalStyles /> 
        <Router>
          {/*
            One Suspense boundary around the whole route tree, with the
            fallback rendered inside <main> by <Layout>. A boundary per route
            would swap the entire page — header and sidebar included — for a
            spinner on every navigation; this way the shell stays put and only
            the content area reports that it is loading.
          */}
          <Suspense fallback={<Layout><RouteFallback /></Layout>}>
          <Routes>
            <Route path="/" element={<LoginPage />} />
            
            {/* LAHAT NG ROUTES AY GUMAGAMIT NA NG moduleName NA TUGMA SA LABELS NATIN */}
            
            <Route path="/dashboard" element={
              <ProtectedRoute moduleName="Dashboard">
                <Layout><Dashboard /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/children" element={
              <ProtectedRoute moduleName="Child Records">
                <Layout><ChildRecords /></Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/children/:id" element={
              <ProtectedRoute moduleName="Child Records">
                <Layout><ChildDetail /></Layout>
              </ProtectedRoute>
            } />
            
            <Route path="/activities" element={
              <ProtectedRoute moduleName="Activities">
                <Layout><Activities /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/activities/:id" element={
              <ProtectedRoute moduleName="Activities">
                <Layout><ActivityDetail /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/assessments" element={
              <ProtectedRoute moduleName="Assessments">
                <Layout><Assessments /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/assessments/:id" element={
              <ProtectedRoute moduleName="Assessments">
                <Layout><AssessmentDetail /></Layout>
              </ProtectedRoute>
            } />

            {/* Guarded by Activities, not Assessments: the page writes
                `activityEvaluations`, which the API and the store both treat as
                an Activities resource. Under the Assessments guard a
                Psychological Staff could open the form and then have every save
                refused, because the role holds no Activities module. */}
            <Route path="/evaluation-form" element={
              <ProtectedRoute moduleName="Activities">
                <Layout><EvaluationForm /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/health" element={
              <ProtectedRoute moduleName="Health">
                <Layout><Health /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/staff" element={
              <ProtectedRoute moduleName="Account Management">
                <Layout><AccountManagement /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/reports" element={
              <ProtectedRoute moduleName="Reports">
                <Layout><Reports /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/violations" element={
              <ProtectedRoute moduleName="Violations">
                <Layout><Violations /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/court-records" element={
              <ProtectedRoute moduleName="Court Records">
                <Layout><CourtRecords /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/social-worker" element={
              <ProtectedRoute moduleName="Social Worker">
                <Layout><SocialWorker /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/documents" element={
              <ProtectedRoute moduleName="Documents">
                <Layout><DocumentUpload /></Layout>
              </ProtectedRoute>
            } />



            <Route path="/education" element={
              <ProtectedRoute moduleName="Education">
                <Layout><Education /></Layout>
              </ProtectedRoute>
            } />

            <Route path="/intervention-tracker" element={<Navigate to="/violations?tab=interventions" replace />} />

            <Route path="/tri" element={
              <ProtectedRoute moduleName="Houseparent">
                <Layout><Tri /></Layout>
              </ProtectedRoute>
            } />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
        </Router>
        </SystemDialogProvider>
      </DataProvider>
    </AuthProvider>
  );
}