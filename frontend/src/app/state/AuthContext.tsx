import React, { createContext, useContext, useState, useEffect } from 'react';

// Idinagdag ang accessibleModules sa User interface
interface User {
  username: string;
  role: 'nurse' | 'psychologist' | 'educator' | 'socialworker' | 'center head' | string;
  accessibleModules: string[]; // Listahan ng mga pages na pwedeng i-access
  childRecordTabs?: string[];  // Granular child record tab access
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, role: string, accessibleModules: string[], token: string, childRecordTabs?: string[]) => void;
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
          setUser(JSON.parse(savedUser));
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

  const login = (username: string, role: string, accessibleModules: string[], newToken: string, childRecordTabs?: string[]) => {
    const userData: User = { 
      username, 
      role, 
      accessibleModules: accessibleModules || [],
      childRecordTabs: childRecordTabs || [],
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
  };

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