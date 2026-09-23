import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/app/components/ui/button';
import systemLogo from '../../assets/sch-logo.png';
import { Lock, User, Eye, EyeOff, AlertCircle } from 'lucide-react';
import { loginRequest } from '@/services/api';
import { useAuth } from '../state/AuthContext';

export function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      const result = await loginRequest(username, password);
      // The server resolves the access matrix; carry its answer into the
      // session so the sidebar and the route guards render exactly what the
      // API will enforce instead of re-deriving it.
      login(
        result.user.username,
        result.user.role,
        result.user.accessibleModules,
        result.token,
        result.user.childRecordTabs,
        result.user.fullName,
        {
          subModules: result.user.subModules,
          access: result.access
            ? { ...result.access, menus: result.user.menus ?? result.access.menus }
            : null,
          fullAccess: result.user.fullAccess,
          permissions: result.user.permissions,
          menus: result.user.menus,
        },
      );
      navigate('/dashboard');
    } catch (err) {
      console.error('Login Error:', err);
      setError(err instanceof Error ? err.message : 'Something went wrong during login.');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#2F3E46] p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-2xl overflow-hidden border border-white/20">
        <div className="p-8 text-black">
          <div className="flex flex-col items-center mb-8">
            <div className="w-20 h-20 bg-[#F8F9FA] rounded-full flex items-center justify-center p-3 mb-4 shadow-inner border border-gray-100">
              <img src={systemLogo} alt="Logo" className="w-full h-full object-contain" />
            </div>
            <h2 className="text-2xl font-bold text-[#2F3E46] tracking-tight">SCH-PATH</h2>
            <p className="text-gray-500 text-sm mt-1">Please sign in to your account</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-5">
            {error && (
              <div className="bg-red-50 border-l-4 border-red-500 p-4 rounded flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0" />
                <p className="text-sm text-red-700 font-medium">{error}</p>
              </div>
            )}

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[#2F3E46] uppercase ml-1">Username</label>
              <div className="relative group">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-[#FFD100] transition-colors" />
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#FFD100] focus:border-transparent outline-none transition-all text-black"
                  placeholder="Enter your username" 
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-bold text-[#2F3E46] uppercase ml-1">Password</label>
              <div className="relative group">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-[#FFD100] transition-colors" />
                <input
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-11 pr-12 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-[#FFD100] focus:border-transparent outline-none transition-all text-black"
                  placeholder="••••••••"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 text-gray-400 hover:text-gray-600 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <Button
              type="submit"
              className="w-full py-6 bg-[#FFD100] hover:bg-[#E6BC00] text-[#2F3E46] font-bold text-lg rounded-xl shadow-lg hover:shadow-[#FFD100]/20 transition-all active:scale-[0.98] mt-4"
            >
              Sign In
            </Button>
          </form>

          <p className="mt-8 text-center text-xs text-gray-400 font-medium">
            &copy; 2025 Second Chance Home. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
}