import React, { createContext, useContext, useState, useEffect } from 'react';
import { UNAUTHORIZED_EVENT } from '@/services/api';
import { canonicalizeModules, type AccessSnapshot, type AccessibleMenu } from '../config/moduleAccess';

/**
 * Local caches written by DataProvider / Education / Account Management. They
 * contain confidential resident and account data, so they must be dropped when
 * the session ends — otherwise the next person on the machine sees the previous
 * user's records. On a shared care-facility workstation that is the normal
 * case, not an edge case.
 *
 * The list previously named `educationSchoolVisits` and
 * `educationMonthlyReports`, but `Education.tsx` writes
 * `educationVisitReports` and `educationProgressReports` — so two of the three
 * Education caches survived logout, as did `educationStudents` and
 * `userAccounts`. A Nurse could sign out and the next person could read the
 * previous user's Education records and the account roster out of
 * localStorage, with no request to the API and no role check.
 *
 * Every key below is asserted against its writer in
 * `backend/tests/session-cache.test.js`, which reads the literals out of the
 * components — so a renamed key fails the build instead of silently leaking.
 */
const CACHED_DATA_KEYS = [
  // state/DataContext.tsx
  'children',
  'staff',
  'activitiesRecords',
  'assessments',
  'reports',
  'violations',
  'alerts',
  'courtRecords',
  // components/Education.tsx
  'educationStudents',
  'educationVisitReports',
  'educationProgressReports',
  'educationMonthlyReports',
  // components/AccountManagement.tsx — the local account roster
  'userAccounts',
];

function clearCachedData() {
  for (const key of CACHED_DATA_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

// Idinagdag ang accessibleModules sa User interface
export interface User {
  username: string;
  fullName?: string | null;
  role: 'nurse' | 'psychologist' | 'educator' | 'socialworker' | 'centerhead' | 'admin' | 'houseparent' | string;
  accessibleModules: string[]; // Listahan ng mga pages na pwedeng i-access
  childRecordTabs?: string[];  // Granular child record tab access
  /**
   * Per-module submenu grants — the hierarchy-aware form of
   * `childRecordTabs`. Written by Account Management and returned by the API.
   */
  subModules?: Record<string, string[]>;
  /**
   * The server's resolved access snapshot (login payload / `GET /api/rbac/me`).
   * When present it is authoritative; `usePermissions()` falls back to
   * resolving the role locally only while it is missing.
   */
  access?: AccessSnapshot | null;
  fullAccess?: boolean;
  permissions?: Record<string, string[]>;
  menus?: AccessibleMenu[];
}

/** Optional extras `login()` accepts; all are additive. */
export interface LoginAccessOptions {
  subModules?: Record<string, string[]>;
  access?: AccessSnapshot | null;
  fullAccess?: boolean;
  permissions?: Record<string, string[]>;
  menus?: AccessibleMenu[];
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (
    username: string,
    role: string,
    accessibleModules: string[],
    token: string,
    childRecordTabs?: string[],
    fullName?: string | null,
    accessOptions?: LoginAccessOptions,
  ) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = () => {
      try {
        const savedUser = localStorage.getItem('user');
        const savedToken = localStorage.getItem('token');
        if (savedUser) {
          const parsed = JSON.parse(savedUser);
          setUser({ ...parsed, accessibleModules: canonicalizeModules(parsed?.accessibleModules) });
        }
        if (savedToken) {
          setToken(savedToken);
        }
      } catch (error) {
        console.error("Auth initialization error:", error);
      } finally {
        setLoading(false);
      }
    };
    checkAuth();
  }, []);

  const login = (
    username: string,
    role: string,
    accessibleModules: string[],
    newToken: string,
    childRecordTabs?: string[],
    fullName?: string | null,
    accessOptions?: LoginAccessOptions,
  ) => {
    const userData: User = {
      username,
      fullName: fullName || null,
      role,
      accessibleModules: canonicalizeModules(accessibleModules),
      childRecordTabs: childRecordTabs || [],
      subModules: accessOptions?.subModules || {},
      access: accessOptions?.access || null,
      fullAccess: accessOptions?.fullAccess,
      permissions: accessOptions?.permissions,
      menus: accessOptions?.menus,
    };

    setUser(userData);
    setToken(newToken);
    localStorage.setItem('user', JSON.stringify(userData));
    localStorage.setItem('token', newToken);
    localStorage.setItem('isAuthenticated', 'true');
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    localStorage.removeItem('user');
    localStorage.removeItem('token');
    localStorage.removeItem('isAuthenticated');
    clearCachedData();
  };

  // An expired or rejected token ends the session instead of leaving the app
  // rendering protected routes from stale local data.
  useEffect(() => {
    const handleUnauthorized = () => {
      setUser(null);
      setToken(null);
      localStorage.removeItem('user');
      localStorage.removeItem('token');
      localStorage.removeItem('isAuthenticated');
      clearCachedData();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handleUnauthorized);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
