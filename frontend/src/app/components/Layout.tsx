import { ReactNode, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/app/components/ui/button';
import { useAuth } from '../state/AuthContext'; 
import systemLogo from '../../assets/sch-logo.png'; 
import { 
  Home, 
  Users, 
  Settings, 
  Calendar, 
  FileText, 
  LogOut, 
  Menu, 
  X,
  ClipboardCheck,
  ShieldAlert,
  Gavel,
  HeartPulse,
  Briefcase,
  GraduationCap,
  TrendingUp
} from 'lucide-react';
import { Notifications } from './Notifications';

interface LayoutProps {
  children: ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  const menuItems = [
    { path: '/dashboard', label: 'Dashboard', icon: Home },
    { path: '/children', label: 'Child Records', icon: Users },
    { path: '/violations', label: 'Violations', icon: ShieldAlert },
    { path: '/intervention-tracker', label: 'Intervention Tracker', icon: TrendingUp },
    { path: '/activities', label: 'Activities', icon: Calendar },
    { path: '/assessments', label: 'Assessments', icon: ClipboardCheck },
    { path: '/health', label: 'Health', icon: HeartPulse },
    { path: '/social-worker', label: 'Social Worker', icon: Briefcase },
    { path: '/court-records', label: 'Court Records', icon: Gavel },
    { path: '/documents', label: 'Documents', icon: FileText },
    { path: '/access-requests', label: 'Access Requests', icon: Users },
    { path: '/reports', label: 'Reports', icon: FileText },
    { path: '/education', label: 'Education', icon: GraduationCap },
    { path: '/staff', label: 'Account Management', icon: Settings },
  ];

  const roleLabels: Record<string, string> = {
    centerhead: 'CENTER HEAD',
    nurse: 'NURSE',
    psychologist: 'PSYCHOLOGIST',
    educator: 'EDUCATOR',
    socialworker: 'SOCIAL WORKER',
  };

  const userRole = user?.role?.toLowerCase();
  const isActive = (path: string) => location.pathname.startsWith(path);

  // Account Management is always visible to centerhead/admin
  const isAdmin = userRole === 'centerhead' || userRole === 'admin';

  const filteredMenuItems = menuItems.filter(item => {
    if (item.label === 'Account Management') return isAdmin;
    if (item.label === 'Access Requests') return true;
    // Centerhead always sees all modules
    if (isAdmin) return true;
    return user?.accessibleModules?.includes(item.label);
  });

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA]">
      {/* HEADER - Consistent with Dark Slate Blue */}
      <header className="shadow-lg border-b-2 border-[#FFD100]/30 bg-[#2F3E46] z-20">
        <div className="px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-full flex items-center justify-center p-1.5 bg-white shadow-inner border border-gray-100">
              <img src={systemLogo} alt="SCH Logo" className="w-full h-full object-contain" />
            </div>
            <div className="text-left">
              <h1 className="font-bold text-base text-white tracking-tight uppercase">SCH-PATH</h1>
              <p className="text-[11px] text-gray-300 font-medium">
                {/* UPDATED: Displays CENTER HEAD specifically */}
                Portal - <span className="uppercase font-bold text-[#FFD100]">
                  {userRole && roleLabels[userRole] ? roleLabels[userRole] : 'CENTER HEAD'}
                </span>
              </p>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="lg:hidden p-2 text-white">
              {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
            </button>
            
            <div className="hidden lg:flex items-center gap-3">
              <Notifications />
              <span className="text-white/60 text-xs font-medium italic mr-2">Welcome, {user?.username}</span>
              <Button 
                onClick={handleLogout} 
                variant="ghost" 
                className="flex items-center gap-2 bg-[#FFD100] text-[#2F3E46] hover:bg-[#E6BC00] font-bold px-5 rounded-lg shadow-sm transition-all"
              >
                <LogOut className="w-4 h-4" />
                <span>Logout</span>
              </Button>
            </div>
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="hidden lg:block w-64 shadow-2xl z-10 bg-[#2F3E46] border-r border-white/5">
          <nav className="p-4 space-y-1.5">
            {filteredMenuItems.length > 0 ? (
              filteredMenuItems.map((item) => (
                <button
                  key={item.path}
                  onClick={() => navigate(item.path)}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                    isActive(item.path) 
                      ? 'bg-[#FFD100] text-[#2F3E46] shadow-lg transform scale-[1.02]' 
                      : 'text-gray-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  <item.icon className={`w-5 h-5 ${isActive(item.path) ? 'text-[#2F3E46]' : 'text-[#FFD100]'}`} />
                  <span className="font-bold text-sm text-left">{item.label}</span>
                </button>
              ))
            ) : (
              <div className="p-4 text-xs text-gray-500 italic">No modules assigned.</div>
            )}
          </nav>
        </aside>

        {/* MOBILE SIDEBAR */}
        {mobileMenuOpen && (
          <div className="lg:hidden fixed inset-0 z-50 bg-[#2F3E46]/80 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)}>
            <aside className="w-72 h-full p-5 bg-[#2F3E46] shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <nav className="space-y-2 mt-12">
                {filteredMenuItems.map((item) => (
                  <button
                    key={item.path}
                    onClick={() => { navigate(item.path); setMobileMenuOpen(false); }}
                    className={`w-full flex items-center gap-4 px-4 py-3 rounded-xl ${
                      isActive(item.path) ? 'bg-[#FFD100] text-[#2F3E46]' : 'text-white hover:bg-white/5'
                    }`}
                  >
                    <item.icon className="w-5 h-5" />
                    <span className="font-bold">{item.label}</span>
                  </button>
                ))}
              </nav>
            </aside>
          </div>
        )}

        {/* MAIN CONTENT AREA */}
        <main className="flex-1 p-5 lg:p-8 bg-[#F0F2F5] overflow-auto text-[#2F3E46]">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}