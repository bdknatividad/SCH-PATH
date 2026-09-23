import { ReactNode, useEffect, useMemo, useState } from 'react';
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

  /**
   * Hold the page still while the drawer is open.
   *
   * The drawer is `fixed inset-0`, so without this a swipe that starts on it
   * scrolls the page behind it instead — on a phone the list under your thumb
   * moves, which reads as the menu being broken. The previous offset is kept so
   * the page does not jump to the top when the drawer closes.
   *
   * `overflow: hidden` alone is not enough on iOS Safari, which scrolls the
   * body anyway; pinning it to a fixed position and restoring the stored offset
   * is what actually stops it.
   */
  useEffect(() => {
    if (!mobileMenuOpen) return;

    const scrollY = window.scrollY;
    const { style } = document.body;
    const previous = {
      position: style.position,
      top: style.top,
      width: style.width,
      overflow: style.overflow,
    };

    style.position = 'fixed';
    style.top = `-${scrollY}px`;
    style.width = '100%';
    style.overflow = 'hidden';

    return () => {
      style.position = previous.position;
      style.top = previous.top;
      style.width = previous.width;
      style.overflow = previous.overflow;
      // Restoring the offset has to happen after position is back to static,
      // otherwise the browser clamps the scroll to the pinned element.
      window.scrollTo(0, scrollY);
    };
  }, [mobileMenuOpen]);

  // A resize past the lg breakpoint hides the drawer with CSS, but the state
  // would stay true and keep the page locked on the way back down to mobile.
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const close = () => setMobileMenuOpen(false);
    query.addEventListener('change', (event) => {
      if (event.matches) close();
    });
    return () => query.removeEventListener('change', close);
  }, []);

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
      {/*
        The header is sticky below `lg` because on a phone the menu button is
        the only way to reach another module; leaving it to scroll away meant
        scrolling back to the top of a long record to navigate. From `lg` up the
        sidebar is always on screen, so the header does not need to follow.
      */}
      <header className="sticky top-0 z-20 border-b-2 border-[#FFD100]/30 bg-[#2F3E46] shadow-lg lg:static">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-6 sm:py-3">
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

      {/*
        Below `lg` this is the page: the document scrolls normally, so the
        browser's own chrome (address bar collapsing, pull-to-refresh,
        rubber-banding, the on-screen keyboard keeping the focused field in
        view) behaves the way it does on every other phone site.

        Scrolling a nested `overflow-auto` box instead is what caused the
        problems: entering a field near the bottom of a long form zoomed the
        keyboard over it without scrolling, the address bar never collapsed, and
        pull-to-refresh did nothing because the gesture was consumed by the
        inner box.

        From `lg` up the two-column shell is restored — the sidebar is a fixed
        rail and the content pane scrolls independently of it, which is the
        desktop behaviour this system already had.
      */}
      <div className="flex min-h-0 flex-1 flex-col lg:h-[calc(100vh-4.75rem)] lg:flex-row lg:overflow-hidden">
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
        <main className="flex-1 p-4 sm:p-5 lg:overflow-auto lg:p-8 bg-[#F0F2F5] text-[#2F3E46]">
          {/*
            `min-w-0` matters here: without it a wide table inside a flex child
            refuses to shrink and pushes the whole page into horizontal
            overflow, which is the usual cause of a page that can be dragged
            sideways on a phone.
          */}
          <div className="mx-auto min-w-0 max-w-7xl">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
