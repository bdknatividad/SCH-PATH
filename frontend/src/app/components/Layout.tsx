import { ReactNode, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/app/components/ui/button';
import { useAuth } from '../state/AuthContext';
import { usePermissions } from '../hooks/usePermissions';
import { MODULE_TREE, ROLE_LABELS } from '@/app/config/rbac';
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
  ClipboardList,
} from 'lucide-react';
import { Notifications } from './Notifications';

interface LayoutProps {
  children: ReactNode;
}

/**
 * Icon per module key. Kept here rather than in the RBAC definition because an
 * icon is a presentation detail — the permission model must not depend on
 * whether `lucide-react` is installed.
 */
const MODULE_ICONS: Record<string, typeof Home> = {
  Dashboard: Home,
  'Child Records': Users,
  Violations: ShieldAlert,
  Activities: Calendar,
  Assessments: ClipboardCheck,
  'Court Records': Gavel,
  Houseparent: ClipboardList,
  Documents: FileText,
  Health: HeartPulse,
  Education: GraduationCap,
  Reports: FileText,
  'Account Management': Settings,
};

/**
 * Fallback icon for a module added to the definition before this map is
 * updated — the sidebar entry still renders, so a new module is never
 * invisible.
 */
const FALLBACK_ICON = Briefcase;

/**
 * Sidebar order and paths.
 *
 * This is deliberately *not* the source of the access model: which modules and
 * submenus exist, and who may see them, comes from the RBAC definition
 * (`MODULE_TREE`). This list only fixes the order they are drawn in and the
 * path each one links to. `backend/tests/rbac.test.js` asserts these module
 * keys and paths match the definition exactly, so the two cannot drift.
 */
const SIDEBAR_ORDER: { module: string; path: string }[] = [
  { module: 'Dashboard', path: '/dashboard' },
  { module: 'Child Records', path: '/children' },
  { module: 'Violations', path: '/violations' },
  { module: 'Activities', path: '/activities' },
  { module: 'Assessments', path: '/assessments' },
  { module: 'Court Records', path: '/court-records' },
  { module: 'Houseparent', path: '/tri' },
  { module: 'Documents', path: '/documents' },
  { module: 'Health', path: '/health' },
  { module: 'Education', path: '/education' },
  { module: 'Reports', path: '/reports' },
  { module: 'Account Management', path: '/staff' },
];

export function Layout({ children }: LayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const { canOpenModule } = usePermissions();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/');
  };

  /**
   * The menu is the canonical RBAC hierarchy filtered by the caller's access:
   * a module the caller may not open is not rendered at all. That is the whole
   * point of driving navigation from the definition — a role change needs no
   * edit here.
   *
   * Deliberately flat — no expandable submenu. The submenus were a second,
   * worse navigation for the same thing: four modules listed their submodules
   * in the sidebar, and clicking one navigated to `<module>?tab=<key>`, which
   * only works when the module page can act on that tab. For Child Records it
   * never could, because those "submodules" are tabs inside a single child's
   * profile and the sidebar has no child selected — so the click changed the
   * URL and nothing else. Each module page already renders its own tabs, and
   * those are aware of the record in front of them. That is now the only way
   * to move between submodules.
   *
   * Submodule *permissions* are unaffected: a withheld tab is still hidden
   * inside the module page (see `useSubModuleTab`), and Account Management
   * still carries the per-submodule checklist.
   */
  const filteredMenuItems = useMemo(() => {
    const treeByKey = new Map(MODULE_TREE.map((module) => [module.key, module]));
    return SIDEBAR_ORDER.filter((entry) => canOpenModule(entry.module)).map((entry) => {
      const definition = treeByKey.get(entry.module);
      return {
        path: entry.path,
        label: definition?.label || entry.module,
        module: entry.module,
        icon: MODULE_ICONS[entry.module] || FALLBACK_ICON,
      };
    });
  }, [canOpenModule]);

  const userRole = user?.role?.toLowerCase();
  const isActive = (path: string) => location.pathname.startsWith(path);

  const renderMenu = (onNavigate?: () => void) =>
    filteredMenuItems.map((item) => {
      const active = isActive(item.path);

      return (
        <button
          key={item.path}
          onClick={() => {
            navigate(item.path);
            onNavigate?.();
          }}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
            active
              ? 'bg-[#FFD100] text-[#2F3E46] shadow-lg'
              : 'text-gray-300 hover:bg-white/5 hover:text-white'
          }`}
        >
          <item.icon className={`w-5 h-5 ${active ? 'text-[#2F3E46]' : 'text-[#FFD100]'}`} />
          <span className="font-bold text-sm text-left flex-1">{item.label}</span>
        </button>
      );
    });

  return (
    <div className="min-h-screen flex flex-col bg-[#F8F9FA]">
      {/* HEADER - Consistent with Dark Slate Blue */}
      <header className="shadow-lg border-b-2 border-[#FFD100]/30 bg-[#2F3E46] z-20">
        <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3 sm:gap-4">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-gray-100 bg-white p-1.5 shadow-inner">
              <img src={systemLogo} alt="SCH Logo" className="h-full w-full object-contain" />
            </div>
            <div className="min-w-0 text-left">
              <h1 className="truncate text-base font-bold uppercase tracking-tight text-white">SCH-PATH</h1>
              <p className="truncate text-[11px] font-medium text-gray-300">
                {/* UPDATED: Displays CENTER HEAD specifically */}
                Portal - <span className="font-bold uppercase text-[#FFD100]">
                  {userRole && ROLE_LABELS[userRole] ? ROLE_LABELS[userRole] : 'CENTER HEAD'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-4">
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

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="hidden lg:block w-64 shadow-2xl z-10 bg-[#2F3E46] border-r border-white/5 overflow-y-auto">
          <nav className="p-4 space-y-1.5">
            {filteredMenuItems.length > 0 ? (
              renderMenu()
            ) : (
              <div className="p-4 text-xs text-gray-500 italic">No modules assigned.</div>
            )}
          </nav>
        </aside>

        {/* MOBILE SIDEBAR */}
        {mobileMenuOpen && (
          <div className="lg:hidden fixed inset-0 z-50 bg-[#2F3E46]/80 backdrop-blur-sm" onClick={() => setMobileMenuOpen(false)}>
            <aside className="flex h-full w-72 max-w-[85vw] flex-col bg-[#2F3E46] p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              {/*
                The header's toggle sits at z-20, underneath this z-50 overlay,
                so it cannot be tapped to close the drawer. Give the drawer its
                own close control.
              */}
              <div className="mb-4 flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-widest text-[#FFD100]">Menu</span>
                <button
                  type="button"
                  aria-label="Close menu"
                  onClick={() => setMobileMenuOpen(false)}
                  className="rounded-lg p-2 text-white hover:bg-white/10"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <nav className="flex-1 space-y-2 overflow-y-auto pb-4">
                {renderMenu(() => setMobileMenuOpen(false))}
              </nav>

              {/*
                Welcome/Notifications/Logout lived in a `hidden lg:flex` block,
                which left phones with no way to log out or read notifications.
              */}
              <div className="mt-auto space-y-3 border-t border-white/10 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs italic text-white/60">Welcome, {user?.username}</span>
                  <Notifications />
                </div>
                <Button
                  onClick={() => {
                    setMobileMenuOpen(false);
                    handleLogout();
                  }}
                  variant="ghost"
                  className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#FFD100] font-bold text-[#2F3E46] shadow-sm transition-all hover:bg-[#E6BC00]"
                >
                  <LogOut className="h-4 w-4" />
                  <span>Logout</span>
                </Button>
              </div>
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
