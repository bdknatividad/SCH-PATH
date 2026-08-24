import { useState, useEffect } from 'react';
import { Bell, X, AlertTriangle, AlertCircle, Info, CheckCircle } from 'lucide-react';
import { Button } from '@/app/components/ui/button';
import { Badge } from '@/app/components/ui/badge';
import { useNavigate } from 'react-router-dom';
import { useData, Alert } from '../state/DataContext';
import { useAuth } from '../state/AuthContext';

export function Notifications() {
  const navigate = useNavigate();
  const { alerts, markAlertAsRead, markAllAlertsAsRead, deleteAlert, unreadAlertsCount, refreshData } = useData();
  const { user } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('unread');

  // Refresh data periodically to get new alerts
  useEffect(() => {
    const interval = setInterval(() => {
      refreshData();
    }, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, [refreshData]);

  const userRole = (user?.role || '').toLowerCase();

  // Only show alerts targeted at the user's role, or general alerts (no targetRole)
  const roleFilteredAlerts = alerts.filter(a => !a.targetRole || a.targetRole === userRole);

  const filteredAlerts = roleFilteredAlerts.filter(a => {
    if (filter === 'unread') return !a.isRead;
    return true;
  }).slice(0, 20); // Show last 20

  const roleUnreadCount = roleFilteredAlerts.filter(a => !a.isRead).length;

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

  const getNavigationPath = (alert: Alert) => {
    if (!alert.residentId) return null;
    
    const tabMap: Record<string, string> = {
      'Document': 'case',
      'Violation': 'behavioral',
      'Medical': 'medical',
      'Behavioral': 'behavioral',
      'Phase': 'timeline',
    };

    const tab = tabMap[alert.type] || 'personal';
    return `/children/${alert.residentId}?tab=${tab}`;
  };

  const handleNotificationClick = async (alert: Alert) => {
    if (!alert.isRead && user?.username) {
      await markAlertAsRead(alert.id, user.username);
    }
    const path = getNavigationPath(alert);
    if (path) {
      setIsOpen(false);
      navigate(path);
    }
  };

  const handleMarkAsRead = async (e: React.MouseEvent, alertId: string) => {
    e.stopPropagation();
    if (user?.username) {
      await markAlertAsRead(alertId, user.username);
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
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        onClick={() => setIsOpen(!isOpen)}
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {roleUnreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center animate-pulse">
            {roleUnreadCount > 9 ? '9+' : roleUnreadCount}
          </span>
        )}
      </Button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-96 bg-white rounded-lg shadow-xl border z-50 max-h-[500px] overflow-hidden">
            <div className="flex items-center justify-between p-4 border-b bg-gray-50">
              <h3 className="font-semibold text-gray-800">Notifications</h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFilter(filter === 'all' ? 'unread' : 'all')}
                  className="text-xs text-blue-600 hover:text-blue-800"
                >
                  {filter === 'all' ? 'Show Unread' : 'Show All'}
                </button>
                <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setIsOpen(false)}>
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div className="overflow-y-auto max-h-[400px]">
              {filteredAlerts.length === 0 ? (
                <div className="p-8 text-center text-gray-500">
                  <Bell className="w-12 h-12 mx-auto mb-3 text-gray-300" />
                  <p>{filter === 'unread' ? 'No unread notifications' : 'No notifications'}</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredAlerts.map((alert: Alert) => (
                    <div
                      key={alert.id}
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
                            <span>{new Date(alert.createdAt || '').toLocaleDateString()}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
                        {!alert.isRead && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={(e) => handleMarkAsRead(e, alert.id)}
                          >
                            Mark as Read
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 text-xs text-red-600 hover:text-red-700"
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
