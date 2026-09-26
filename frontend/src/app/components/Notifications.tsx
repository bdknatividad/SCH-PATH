import { useState, useEffect } from 'react';
import { Bell, X, AlertTriangle, AlertCircle, Info, CheckCircle } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { useData, Alert } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';
import { MODULE_TREE, canOpenModule } from '../config/moduleAccess';
import { streamAlerts } from '@/services/api';

/**
 * Which module a route belongs to, derived from the RBAC hierarchy.
 *
 * Used to answer "can this user actually open that page?" before sending them
 * there. `ProtectedRoute` would otherwise bounce them to their first accessible
 * module, so a notification would appear to do nothing.
 *
 * Derived rather than hand-written: a module added to the definition is
 * reachable from here with no edit, and the two cannot disagree about routes.
 */
const ROUTE_MODULE: Record<string, string> = MODULE_TREE.reduce<Record<string, string>>(
  (accumulator, module) => {
    const segment = module.route.replace(/^\//, '').split('/').filter(Boolean)[0];
    if (segment) accumulator[segment] = module.key;
    return accumulator;
  },
  {},
);

/** The child-detail tabs that actually exist. `case` was never one of them. */
const CHILD_TABS = new Set(['personal', 'timeline', 'education', 'medical', 'behavioral']);

export function Notifications() {
  const navigate = useNavigate();
  const {
    alerts, markAlertAsRead, markAllAlertsAsRead, deleteAlert,
    refreshAlerts, unreadAlertsCount, isLoading, error,
  } = useData();
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');
  const [pendingAlertId, setPendingAlertId] = useState<string | null>(null);

  // Poll only the notification feed. The old handler re-fetched every
  // collection in the system (children, documents, base64 file data) once every
  // 30 seconds just to notice a new alert.
  //
  // This is now the *fallback*. The stream below is what makes a notification
  // arrive immediately; this stays because it is the only thing that still works
  // if a proxy buffers or blocks the stream, and a bell that silently stops
  // updating is worse than a slow one.
  useEffect(() => {
    const interval = setInterval(() => { void refreshAlerts(); }, 30000);
    return () => clearInterval(interval);
  }, [refreshAlerts]);

  // The live channel. The server pushes a frame whenever something addressed to
  // this user is written, and we answer it by re-reading the feed — which is the
  // only place visibility is decided, so a signal for the wrong person costs a
  // wasted request and never a disclosure.
  //
  // Reconnects with capped backoff: a dropped stream (a deploy, a sleeping
  // laptop, a flaky network) must not leave the bell frozen for the rest of the
  // session. A clean end resets the backoff so a redeploy reconnects at once.
  useEffect(() => {
    const controller = new AbortController();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        await streamAlerts(() => { void refreshAlerts(); }, controller.signal);
        attempt = 0;
      } catch {
        // Aborted by the cleanup below, or the connection dropped — either way
        // the retry decision is made after this block.
      }
      if (controller.signal.aborted) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 30000);
      timer = setTimeout(() => { void connect(); }, delay);
    };

    void connect();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [refreshAlerts]);

  // Refreshing on window focus means switching back to the app shows what
  // happened while it was in the background, instead of waiting up to 30s.
  useEffect(() => {
    const onFocus = () => { void refreshAlerts(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAlerts]);

  // The list is already scoped to this user by the backend. The `targetRole`
  // filter that used to sit here compared raw strings ("SocialWorker") against a
  // lower-cased role, so it silently dropped alerts the user was entitled to —
  // and it was the only thing hiding other roles' alerts from the panel.
  const filteredAlerts = alerts.filter(a => (filter === 'unread' ? !a.isRead : true)).slice(0, 20);

  // The badge is the server's number, so it always matches the list above.
  const roleUnreadCount = unreadAlertsCount;

  const getPriorityIcon = (priority: string) => {
    switch (priority) {
      case 'Urgent': return <AlertTriangle className="w-4 h-4 text-red-500" />;
      case 'High': return <AlertCircle className="w-4 h-4 text-orange-500" />;
      case 'Medium': return <Info className="w-4 h-4 text-yellow-500" />;
      default: return <CheckCircle className="w-4 h-4 text-green-500" />;
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'Urgent': return 'bg-red-100 text-red-800 border-red-200';
      case 'High': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'Medium': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      default: return 'bg-green-100 text-green-800 border-green-200';
    }
  };

  /**
   * Is this destination reachable by the signed-in user?
   *
   * Answered by the RBAC model, so it agrees with `ProtectedRoute` by
   * construction: full-access roles pass everything and a role holding every
   * module passes without a special case. Ungated routes — `/intervention-tracker`
   * has no `moduleName` — are open to everyone.
   */
  const canReach = (path: string) => {
    const segment = path.split('?')[0].split('/').filter(Boolean)[0] || '';
    const moduleName = ROUTE_MODULE[segment];
    if (!moduleName) return true;
    return canOpenModule(user?.role, user?.accessibleModules, moduleName);
  };

  /** The same fallback ProtectedRoute would pick, so nothing appears to happen. */
  const fallbackPath = () => {
    const first = MODULE_TREE
      .filter(module => canOpenModule(user?.role, user?.accessibleModules, module.key))
      .map(module => module.route.replace(/^\//, '').split('/')[0])
      .find(Boolean);
    return first ? `/${first}` : '/dashboard';
  };

  const getNavigationPath = (alert: Alert) => {
    const relatedRecordType = alert.relatedRecordType?.toLowerCase();
    const relatedRecordId = alert.relatedRecordId;
    const resident = alert.residentId;

    const childTab = (tab: string) =>
      resident ? `/children/${encodeURIComponent(resident)}?tab=${CHILD_TABS.has(tab) ? tab : 'personal'}` : null;

    let target: string | null = null;

    switch (relatedRecordType) {
      case 'accessrequests':
        // The standalone Access Requests page was removed — document-level
        // access requests are handled directly within Documents.
        target = '/documents';
        break;
      case 'activities':
        target = relatedRecordId ? `/activities/${encodeURIComponent(relatedRecordId)}` : '/activities';
        break;
      case 'assessments':
        target = relatedRecordId ? `/assessments/${encodeURIComponent(relatedRecordId)}` : '/assessments';
        break;
      case 'tri':
        target = `/tri?residentId=${encodeURIComponent(resident || '')}`;
        break;
      // "Anecdotal Report needs review" opens the Social Worker's Needs Review
      // tab with the submitted report already loaded.
      case 'anecdotal report':
        target = relatedRecordId
          ? `/reports?tab=review&anecdotalId=${encodeURIComponent(relatedRecordId)}`
          : '/reports';
        break;
      // Assignment, submission and approval notices all open the exact report,
      // so the recipient lands on the section they were told about. The report
      // is a card inside the Reports module, so the deep link carries the report
      // id and the page opens it.
      case 'quarterly progress report':
        target = relatedRecordId
          ? `/reports?quarterlyReportId=${encodeURIComponent(relatedRecordId)}`
          : '/reports';
        break;
      case 'healthrecords':
        target = resident ? `/health?residentId=${encodeURIComponent(resident)}` : '/health';
        break;
      case 'documents':
        // A document alert names the exact file, so open it rather than the
        // folder list. `DocumentUpload` reads `docId` and opens that record's
        // preview; without one it simply stays on the list.
        target = relatedRecordId
          ? `/documents?tab=folders&docId=${encodeURIComponent(relatedRecordId)}`
          : '/documents';
        break;
      // Form 08 and the intervention it belongs to both live in the Violations
      // module, which every role that can act on them holds.
      case 'incidentreports':
      case 'violation':
        target = childTab('behavioral') || '/violations';
        break;
      case 'phaseprogress':
        target = childTab('timeline') || '/children';
        break;
      case 'residentassignments':
        target = childTab('personal') || '/children';
        break;
      case 'admissions':
      case 'children':
        // Medical Notes changes open the resident's Medical tab. A Houseparent
        // has no Child Records module, so they are sent to the same record
        // inside their Houseparent Case Load instead.
        if (alert.type === 'medical-notes-updated' && resident) {
          target = canReach('/children')
            ? childTab('medical')
            : `/tri?tab=caseload&caseloadResidentId=${encodeURIComponent(resident)}&childTab=medical`;
          break;
        }
        target = childTab('personal') || '/children';
        break;
      default:
        target = null;
    }

    // Fall back to the alert type when there is no record link to follow.
    if (!target) {
      switch (alert.type) {
        case 'Violation Intervention':
          // The tracker lives inside the Violations module, but it must open for
          // EVERY role that can receive this alert — including ones with no
          // Violations access. `/violations?tab=interventions` is gated by
          // `canReach`, so those roles were bounced to the fallback page and the
          // alert appeared to do nothing. `/intervention-tracker` has no
          // `moduleName` (it redirects to the same tab), so it is reachable by
          // everyone.
          target = '/intervention-tracker';
          break;
        case 'Phase Demotion':
        case 'Phase Progress':
          target = childTab('timeline');
          break;
        case 'Document Approved':
        case 'Document Rejected':
        case 'Document For Reassessment':
        case 'Incident Report Failed':
        case 'Incident Report For Reassessment':
        case 'Incident Report Resubmitted':
        case 'TRI For Reassessment':
        case 'TRI Resubmitted':
        case 'TRI Submitted':
        case 'TRI Finalized':
        case 'Assessment Completed':
        case 'Assessment Required':
        case 'Document':
          target = '/documents';
          break;
        case 'Quarterly Progress Report':
          target = '/reports';
          break;
        case 'Incident Report':
        case 'Violation':
          target = childTab('behavioral') || '/violations';
          break;
        case 'Admission':
        case 'Assignment':
          target = childTab('personal');
          break;
        default:
          target = resident ? childTab('personal') : null;
      }
    }

    if (!target) target = '/dashboard';

    // Never send someone to a page their role cannot open — ProtectedRoute
    // would bounce them and the click would look broken.
    return canReach(target) ? target : fallbackPath();
  };

  const handleNotificationClick = async (alert: Alert) => {
    if (pendingAlertId) return;

    setPendingAlertId(alert.id);
    try {
      if (!alert.isRead && user?.username) {
        await markAlertAsRead(alert.id, user.username);
      }
      setIsOpen(false);
      navigate(getNavigationPath(alert));
    } finally {
      setPendingAlertId(null);
    }
  };

  const handleMarkAsRead = async (e: React.MouseEvent, alertId: string) => {
    e.stopPropagation();
    if (!user?.username || pendingAlertId) return;

    setPendingAlertId(alertId);
    try {
      await markAlertAsRead(alertId, user.username);
    } finally {
      setPendingAlertId(null);
    }
  };

  const handleDelete = async (e: React.MouseEvent, alertId: string) => {
    e.stopPropagation();
    await deleteAlert(alertId);
  };

  const handleMarkAllAsRead = async () => {
    if (user?.username) {
      await markAllAlertsAsRead(user.username);
      setFilter('all');
    }
  };

  return (
    <div className="relative">
      {/*
        The bell sits on the dark `#2F3E46` header, so it is drawn in white with
        a hover wash instead of the old `text-gray-600` — dark grey on dark slate
        was almost invisible, which on a phone made the control look absent.
        `size-10` rather than the default `size-9` gives a touch target that is
        comfortable to hit with a thumb.
      */}
      <Button
        variant="ghost"
        size="icon"
        className="relative size-10 rounded-lg text-white hover:bg-white/10 hover:text-white"
        data-testid="notification-bell"
        aria-label={`Notifications${roleUnreadCount > 0 ? ` (${roleUnreadCount} unread)` : ''}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <Bell className="h-5 w-5" />
        {roleUnreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold leading-none text-white ring-2 ring-[#2F3E46]"
          >
            {roleUnreadCount > 9 ? '9+' : roleUnreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          {/*
            The panel is anchored to the viewport on phones and to the button
            from `sm` up.

            `w-96` is 384px, which is wider than the viewport of a 360px Android
            phone, and `absolute right-0` pinned the panel's right edge to the
            bell's — so on a narrow screen the left portion (title, filter
            toggle) was pushed off-screen and unreachable. `fixed` positioning
            with explicit insets keeps the whole panel on screen; the `sm:`
            variants restore the desktop popover behaviour unchanged.
          */}
          <div
            data-testid="notification-panel"
            className="fixed inset-x-3 top-[4.5rem] z-50 overflow-hidden rounded-lg border bg-white shadow-xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-96"
          >
            <div className="flex items-center justify-between gap-2 border-b bg-gray-50 p-3 sm:p-4">
              <h3 className="truncate font-semibold text-gray-800">Notifications</h3>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => setFilter(filter === 'all' ? 'unread' : 'all')}
                  className="whitespace-nowrap text-xs text-blue-600 hover:text-blue-800"
                >
                  {filter === 'all' ? 'Show Unread' : 'Show All'}
                </button>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            {error && (
              <div className="px-4 py-2 text-xs text-red-600 bg-red-50 border-b border-red-100">
                Unable to update notifications: {error}
              </div>
            )}

            {/*
              A fixed 400px list plus the header and footer can exceed the
              viewport on a short phone in landscape, which would push the
              "Mark all as read" control out of reach. The list is capped
              against the viewport with `dvh` (which accounts for the mobile
              browser's collapsing chrome, unlike `vh`) and falls back to the
              old fixed cap from `sm` up.
            */}
            <div className="max-h-[calc(100dvh-11rem)] overflow-y-auto sm:max-h-[400px]">
              {isLoading ? (
                <div className="p-8 text-center text-gray-500">Loading notifications...</div>
              ) : error && alerts.length === 0 ? (
                <div className="p-8 text-center text-red-600">Unable to load notifications.</div>
              ) : filteredAlerts.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Bell className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>{filter === 'unread' ? 'No unread notifications' : 'No notifications'}</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredAlerts.map((alert: Alert) => (
                    <div
                      key={alert.id}
                      data-testid="notification-row"
                      data-alert-id={alert.id}
                      data-unread={!alert.isRead ? 'true' : 'false'}
                      onClick={() => handleNotificationClick(alert)}
                      className={`p-4 hover:bg-gray-50 transition-colors cursor-pointer ${!alert.isRead ? 'bg-blue-50/50' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">{getPriorityIcon(alert.priority)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-medium text-gray-500">{alert.type}</span>
                            <Badge variant="outline" className={`text-xs ${getPriorityColor(alert.priority)}`}>
                              {alert.priority}
                            </Badge>
                            {!alert.isRead && (
                              <span className="w-2 h-2 bg-blue-500 rounded-full" />
                            )}
                          </div>
                          <p className="text-sm font-medium text-gray-900 mb-1">{alert.title}</p>
                          <p className="text-xs text-gray-600 mb-2 line-clamp-2">{alert.message}</p>
                          {alert.actionRequired && (
                            <p className="text-xs text-blue-600 mb-2">Action: {alert.actionRequired}</p>
                          )}
                          <div className="flex items-center gap-2 text-xs text-gray-400">
                            <span>{alert.createdAt ? new Date(alert.createdAt).toLocaleDateString() : ''}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                        {!alert.isRead && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            data-testid="notification-mark-read"
                            disabled={pendingAlertId === alert.id}
                            onClick={(e) => handleMarkAsRead(e, alert.id)}
                          >
                            {pendingAlertId === alert.id ? 'Saving...' : 'Mark as Read'}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700"
                          data-testid="notification-delete"
                          onClick={(e) => handleDelete(e, alert.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {filteredAlerts.length > 0 && filter === 'unread' && roleUnreadCount > 0 && (
              <div className="p-3 border-t bg-gray-50 text-center">
                <button
                  data-testid="notification-mark-all"
                  onClick={handleMarkAllAsRead}
                  className="text-sm text-blue-600 hover:text-blue-800 font-semibold"
                >
                  Mark all as read
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
