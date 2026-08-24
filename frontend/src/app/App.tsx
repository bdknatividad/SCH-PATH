import React, { Component, ErrorInfo, ReactNode } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/AuthContext';
import { DataProvider } from './state/DataContext'; 

import { Layout } from '@/app/components/Layout';
import { LoginPage } from '@/app/components/LoginPage';
import { InterventionTracker } from '@/app/components/InterventionTracker';
import { Dashboard } from '@/app/components/Dashboard';
import { ChildRecords } from '@/app/components/ChildRecords';
import { ChildDetail } from '@/app/components/ChildDetail';
import { Activities } from '@/app/components/Activities';
import ActivityDetail from '@/app/components/ActivityDetail'; 
import EvaluationForm from '@/app/components/EvaluationForm'; 

import { Assessments } from '@/app/components/Assessments';
import { AssessmentDetail } from '@/app/components/AssessmentDetail';
import { Health } from '@/app/components/Health';
import { AccountManagement } from '@/app/components/AccountManagement';
import { Reports } from '@/app/components/Reports';
import { Violations } from '@/app/components/Violations';
import { CourtRecords } from '@/app/components/CourtRecords';
import { SocialWorker } from '@/app/components/SocialWorker';
import { DocumentUpload } from '@/app/components/DocumentUpload';
import { Education } from '@/app/components/Education';

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, errorInfo: ErrorInfo) { console.error("Uncaught error:", error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="p-10 bg-red-50 text-red-700">
          <h1 className="text-xl font-bold">May Error sa Component:</h1>
          <pre className="mt-2 text-sm">{this.state.error?.message}</pre>
          <button className="mt-4 px-4 py-2 bg-red-600 text-white rounded" onClick={() => window.location.reload()}>Reload Page</button>
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
function ProtectedRoute({ children, moduleName }: { children: React.ReactNode, moduleName?: string }) {
  const { user, loading } = useAuth(); 
  const isAuthenticated = localStorage.getItem('isAuthenticated') === 'true';

  if (loading) {
    return <div className="flex h-screen items-center justify-center">Loading authentication...</div>;
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/" replace />;
  }

  // Admin and centerhead always have full access to all modules
  const role = user.role?.toLowerCase();
  const isAdmin = role === 'admin' || role === 'centerhead';

  if (moduleName && !isAdmin && !user.accessibleModules?.includes(moduleName)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <ErrorBoundary>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <AuthProvider>
      <DataProvider>
        <GlobalStyles /> 
        <Router>
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

            <Route path="/evaluation-form" element={
              <ProtectedRoute moduleName="Assessments">
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

            <Route path="/intervention-tracker" element={
              <ProtectedRoute>
                <Layout><InterventionTracker /></Layout>
              </ProtectedRoute>
            } />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Router>
      </DataProvider>
    </AuthProvider>
  );
}