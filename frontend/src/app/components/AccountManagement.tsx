import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/app/components/ui/card';
import { Button } from '@/app/components/ui/button';
import { Input } from '@/app/components/ui/input';
import { Badge } from '@/app/components/ui/badge';
import { Plus, Edit, Trash2, AlertCircle, CheckSquare, Square, Search, Shield, Eye, EyeOff } from 'lucide-react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/app/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/app/components/ui/alert-dialog';
import { Label } from '@/app/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/app/components/ui/select';
import { createResource, deleteResource, getStore, updateResource } from '@/services/api';
import { useAuth } from '../state/AuthContext';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'userAccounts';

// Child Records sub-tabs (granular access)
const CHILD_RECORD_TABS = [
  'Personal Info',
  'Phase Timeline',
  'Case Progress',
  'Medical',
  'Behavioral',
];

const AVAILABLE_MODULES = [
  'Dashboard',
  'Child Records',
  'Violations',
  'Activities',
  'Assessments',
  'Health',
  'Court Records',
  'Documents',
  'Reports',
  'Account Management',
  'Education',
];

const USER_ROLES = ['centerhead', 'nurse', 'psychologist', 'educator', 'socialworker'];

const DEFAULT_MODULE_ACCESS: Record<string, string[]> = {
  centerhead:   AVAILABLE_MODULES,
  nurse:        ['Dashboard', 'Child Records', 'Health', 'Documents'],
  psychologist: ['Dashboard', 'Child Records', 'Assessments', 'Violations', 'Documents', 'Reports'],
  educator:     ['Dashboard', 'Child Records', 'Activities', 'Documents', 'Education'],
  socialworker: ['Dashboard', 'Child Records', 'Violations', 'Court Records', 'Documents', 'Reports'],
};

const DEFAULT_CHILD_TAB_ACCESS: Record<string, string[]> = {
  centerhead:   CHILD_RECORD_TABS,
  nurse:        ['Personal Info', 'Medical'],
  psychologist: ['Personal Info', 'Phase Timeline', 'Case Progress', 'Behavioral'],
  educator:     ['Personal Info', 'Phase Timeline', 'Case Progress'],
  socialworker: CHILD_RECORD_TABS,
};

const DEFAULT_USERS = [
  {
    id: 'U001',
    username: 'centerhead',
    password: 'centerhead123',
    role: 'centerhead',
    accessibleModules: AVAILABLE_MODULES,
    childRecordTabs: CHILD_RECORD_TABS,
    status: 'Active' as const,
    createdDate: '2025-01-01',
  },
];

// ── TYPES ────────────────────────────────────────────────────────────────────
interface User {
  id: string;
  username: string;
  password: string;
  role: string;
  accessibleModules: string[];
  childRecordTabs: string[];
  status: 'Active' | 'Inactive';
  createdDate: string;
}

interface UserForm {
  username: string;
  password: string;
  role: string;
  accessibleModules: string[];
  childRecordTabs: string[];
}

const EMPTY_FORM: UserForm = {
  username: '',
  password: '',
  role: '',
  accessibleModules: [],
  childRecordTabs: [],
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  centerhead:   { bg: '#FEE2E2', text: '#991B1B' },
  nurse:        { bg: '#DBEAFE', text: '#1E40AF' },
  psychologist: { bg: '#FEF3C7', text: '#92400E' },
  educator:     { bg: '#D1FAE5', text: '#065F46' },
  socialworker: { bg: '#E0E7FF', text: '#3730A3' },
};

function roleLabel(role: string) {
  if (role === 'centerhead') return 'Center Head';
  if (role === 'socialworker') return 'Social Worker';
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function loadUsers(): User[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_USERS;
    const parsed: User[] = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_USERS;

    // Remove stale "admin" role entry — centerhead was previously remapped to admin
    const cleaned = parsed.filter(u => u.role !== 'admin');

    // Ensure exactly one centerhead exists
    const hasCenterhead = cleaned.some(u => u.role === 'centerhead');
    if (!hasCenterhead) return [DEFAULT_USERS[0], ...cleaned];

    return cleaned;
  } catch {
    return DEFAULT_USERS;
  }
}

function saveUsers(users: User[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(users));
}

// ── COMPONENT ────────────────────────────────────────────────────────────────
export function AccountManagement() {
  const { user: currentUser, login } = useAuth();
  const [users, setUsers] = useState<User[]>(() => loadUsers());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRole, setFilterRole] = useState('all');

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<UserForm>(EMPTY_FORM);
  const [addError, setAddError] = useState('');
  const [showAddPassword, setShowAddPassword] = useState(false);

  // Edit dialog
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState<UserForm>(EMPTY_FORM);
  const [editError, setEditError] = useState('');
  const [showEditPassword, setShowEditPassword] = useState(false);

  // Delete dialog
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [userToDelete, setUserToDelete] = useState<User | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  // Persist whenever users change
  useEffect(() => {
    saveUsers(users);
  }, [users]);

  useEffect(() => {
    const loadBackendUsers = async () => {
      try {
        const store = await getStore();
        if (Array.isArray(store.users) && store.users.length > 0) {
          setUsers(store.users.filter((u: User) => u.role !== 'admin'));
        }
      } catch (err) {
        console.error('Unable to load backend users:', err);
      }
    };

    loadBackendUsers();
  }, []);

  // ── ADD ────────────────────────────────────────────────────────────────────
  const openAdd = () => {
    setAddForm(EMPTY_FORM);
    setAddError('');
    setShowAddPassword(false);
    setIsAddOpen(true);
  };

  const handleAddRoleChange = (role: string) => {
    setAddForm(prev => ({
      ...prev,
      role,
      accessibleModules: DEFAULT_MODULE_ACCESS[role] || ['Dashboard'],
      childRecordTabs: DEFAULT_CHILD_TAB_ACCESS[role] || CHILD_RECORD_TABS,
    }));
  };

  const toggleAddModule = (mod: string) => {
    setAddForm(prev => ({
      ...prev,
      accessibleModules: prev.accessibleModules.includes(mod)
        ? prev.accessibleModules.filter(m => m !== mod)
        : [...prev.accessibleModules, mod],
    }));
  };

  const toggleAddChildTab = (tab: string) => {
    setAddForm(prev => ({
      ...prev,
      childRecordTabs: prev.childRecordTabs.includes(tab)
        ? prev.childRecordTabs.filter(t => t !== tab)
        : [...prev.childRecordTabs, tab],
    }));
  };

  const handleAddUser = async () => {
    setAddError('');
    if (!addForm.username.trim()) { setAddError('Username is required.'); return; }
    if (!addForm.password.trim()) { setAddError('Password is required.'); return; }
    if (!addForm.role) { setAddError('Please select a role.'); return; }
    if (users.some(u => (u.username || '').toLowerCase() === addForm.username.trim().toLowerCase())) {
      setAddError('Username already exists.'); return;
    }

    const newUser: User = {
      id: `U${String(Date.now()).slice(-4)}`,
      username: addForm.username.trim(),
      password: addForm.password.trim(),
      role: addForm.role,
      accessibleModules: addForm.accessibleModules.length > 0
        ? addForm.accessibleModules
        : ['Dashboard'],
      childRecordTabs: addForm.childRecordTabs.length > 0
        ? addForm.childRecordTabs
        : CHILD_RECORD_TABS,
      status: 'Active',
      createdDate: new Date().toISOString().split('T')[0],
    };

    try {
      const saved = await createResource<User>('users', newUser);
      const updated = [...users, saved];
      setUsers(updated);
      saveUsers(updated);
      setIsAddOpen(false);
      setAddForm(EMPTY_FORM);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Unable to add user.');
    }
  };

  // ── EDIT ───────────────────────────────────────────────────────────────────
  const openEdit = (user: User) => {
    setEditingUser(user);
    setEditForm({
      username: user.username,
      password: user.password,
      role: user.role,
      accessibleModules: [...user.accessibleModules],
      childRecordTabs: [...(user.childRecordTabs || CHILD_RECORD_TABS)],
    });
    setEditError('');
    setShowEditPassword(false);
    setIsEditOpen(true);
  };

  const handleEditRoleChange = (role: string) => {
    setEditForm(prev => ({
      ...prev,
      role,
      accessibleModules: DEFAULT_MODULE_ACCESS[role] || ['Dashboard'],
      childRecordTabs: DEFAULT_CHILD_TAB_ACCESS[role] || CHILD_RECORD_TABS,
    }));
  };

  const toggleEditModule = (mod: string) => {
    setEditForm(prev => ({
      ...prev,
      accessibleModules: prev.accessibleModules.includes(mod)
        ? prev.accessibleModules.filter(m => m !== mod)
        : [...prev.accessibleModules, mod],
    }));
  };

  const toggleEditChildTab = (tab: string) => {
    setEditForm(prev => ({
      ...prev,
      childRecordTabs: prev.childRecordTabs.includes(tab)
        ? prev.childRecordTabs.filter(t => t !== tab)
        : [...prev.childRecordTabs, tab],
    }));
  };

  const handleEditUser = async () => {
    setEditError('');
    if (!editForm.username.trim()) { setEditError('Username is required.'); return; }
    if (!editingUser) return;

    const conflict = users.find(
      u => (u.username || '').toLowerCase() === editForm.username.trim().toLowerCase() && u.id !== editingUser.id
    );
    if (conflict) { setEditError('Username already taken.'); return; }

    const updated = users.map(u =>
      u.id === editingUser.id
        ? {
            ...u,
            username: editForm.username.trim(),
            password: editForm.password.trim() || u.password,
            role: editForm.role,
            accessibleModules: editForm.accessibleModules.length > 0
              ? editForm.accessibleModules
              : ['Dashboard'],
            childRecordTabs: editForm.childRecordTabs.length > 0
              ? editForm.childRecordTabs
              : CHILD_RECORD_TABS,
          }
        : u
    );

    try {
      await updateResource<User>('users', editingUser.id, updated.find(u => u.id === editingUser.id) as User);
      setUsers(updated);
      saveUsers(updated);

      // If the edited user is the currently logged-in user, refresh their session
      const editedUser = updated.find(u => u.id === editingUser.id);
      if (editedUser && currentUser && editedUser.username === currentUser.username) {
        const savedToken = localStorage.getItem('token') || '';
        login(editedUser.username, editedUser.role, editedUser.accessibleModules, savedToken, editedUser.childRecordTabs);
      }

      setIsEditOpen(false);
      setEditingUser(null);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Unable to update user.');
    }
  };

  // ── DELETE ─────────────────────────────────────────────────────────────────
  const openDelete = (user: User) => {
    setUserToDelete(user);
    setDeleteConfirm('');
    setIsDeleteOpen(true);
  };

  const handleDelete = async () => {
    if (!userToDelete || deleteConfirm !== userToDelete.username) return;
    const updated = users.filter(u => u.id !== userToDelete.id);
    try {
      await deleteResource('users', userToDelete.id);
      setUsers(updated);
      saveUsers(updated);
      setIsDeleteOpen(false);
      setUserToDelete(null);
      setDeleteConfirm('');
    } catch (err) {
      console.error('Unable to delete user:', err);
    }
  };

  // ── FILTER ─────────────────────────────────────────────────────────────────
  const filtered = users.filter(u => {
    const matchSearch =
      (u.username || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
      u.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchRole = filterRole === 'all' || u.role === filterRole;
    return matchSearch && matchRole;
  });

  // ── MODULE CHECKLIST ────────────────────────────────────────────────────────
  function ModuleChecklist({
    selected,
    onToggle,
  }: { selected: string[]; onToggle: (mod: string) => void }) {
    return (
      <div className="grid grid-cols-1 gap-1.5 border rounded-xl p-3 bg-gray-50">
        {AVAILABLE_MODULES.map(mod => (
          <div
            key={mod}
            className="flex items-center gap-2 cursor-pointer p-1.5 rounded-lg hover:bg-white transition-colors"
            onClick={() => onToggle(mod)}
          >
            {selected.includes(mod)
              ? <CheckSquare className="w-4 h-4 text-[#2F3E46] shrink-0" />
              : <Square className="w-4 h-4 text-gray-300 shrink-0" />
            }
            <span className="text-sm">{mod}</span>
          </div>
        ))}
      </div>
    );
  }

  // ── RENDER ─────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="bg-[#2F3E46] p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
        <h2 className="text-2xl font-bold mb-1 text-white">Account Management</h2>
        <p className="text-gray-300">Manage user accounts and module access permissions</p>
      </div>

      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 justify-between items-start sm:items-center">
        <div className="flex gap-2 flex-1 w-full sm:max-w-md">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <Input
              className="pl-10 rounded-xl"
              placeholder="Search by username or ID..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
            />
          </div>
          <Select value={filterRole} onValueChange={setFilterRole}>
            <SelectTrigger className="w-40 rounded-xl">
              <SelectValue placeholder="All Roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Roles</SelectItem>
              {USER_ROLES.map(r => (
                <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={openAdd}
          className="gap-2 font-bold rounded-xl px-5 shrink-0"
          style={{ backgroundColor: '#FFD100', color: '#2F3E46' }}
        >
          <Plus className="w-4 h-4" /> Add User
        </Button>
      </div>

      {/* User Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filtered.length === 0 ? (
          <div className="col-span-3 text-center py-16 text-gray-400">
            <AlertCircle className="w-10 h-10 mx-auto mb-2 opacity-20" />
            <p className="text-sm italic">No users found.</p>
          </div>
        ) : (
          filtered.map(user => {
            const roleColor = ROLE_COLORS[user.role] || { bg: '#F3F4F6', text: '#374151' };
            const isCenterhead = user.role === 'centerhead';
            return (
              <Card
                key={user.id}
                className="overflow-hidden border-none shadow-md hover:shadow-lg transition-shadow rounded-2xl"
              >
                <div className="h-1.5" style={{ backgroundColor: roleColor.text }} />
                <CardContent className="p-5">
                  <div className="flex justify-between items-start mb-3">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-9 h-9 rounded-full flex items-center justify-center font-black text-sm"
                        style={{ backgroundColor: roleColor.bg, color: roleColor.text }}
                      >
                        {user.username.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-bold text-[#2F3E46]">{user.username}</p>
                        <p className="text-[10px] text-gray-400 font-mono">{user.id}</p>
                      </div>
                    </div>
                    <Badge
                      className="border-none text-[10px] font-bold"
                      style={{ backgroundColor: roleColor.bg, color: roleColor.text }}
                    >
                      {roleLabel(user.role)}
                    </Badge>
                  </div>

                  {/* Module access pills */}
                  <div className="flex flex-wrap gap-1 mb-3 min-h-[28px]">
                    {user.accessibleModules.map(mod => (
                      <Badge key={mod} variant="outline" className="text-[9px] font-normal px-1.5 py-0">
                        {mod}
                      </Badge>
                    ))}
                  </div>

                  <div className="flex justify-between items-center pt-2 border-t border-gray-100">
                    <div className="flex items-center gap-1 text-[10px] text-gray-400">
                      {isCenterhead && <Shield className="w-3 h-3 text-red-400" />}
                      <span>Since {user.createdDate}</span>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 hover:bg-[#FFD100]/20"
                        onClick={() => openEdit(user)}
                        title="Edit"
                      >
                        <Edit className="w-4 h-4 text-[#2F3E46]" />
                      </Button>
                      {!isCenterhead && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 hover:bg-red-50 text-red-400 hover:text-red-600"
                          onClick={() => openDelete(user)}
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })
        )}
      </div>

      {/* ── ADD DIALOG ── */}
      <Dialog open={isAddOpen} onOpenChange={open => { if (!open) setIsAddOpen(false); }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold">Add New User</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {addError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {addError}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Username *</Label>
              <Input
                value={addForm.username}
                onChange={e => setAddForm(p => ({ ...p, username: e.target.value }))}
                placeholder="e.g. nurse_juan"
                className="rounded-xl"
              />
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Password *</Label>
              <div className="relative">
                <Input
                  type={showAddPassword ? 'text' : 'password'}
                  value={addForm.password}
                  onChange={e => setAddForm(p => ({ ...p, password: e.target.value }))}
                  placeholder="Enter password"
                  className="rounded-xl pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowAddPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showAddPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Role *</Label>
              <Select value={addForm.role || undefined} onValueChange={handleAddRoleChange}>
                <SelectTrigger className="rounded-xl">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {USER_ROLES.map(r => (
                    <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Module Access</Label>
              <p className="text-xs text-gray-400">Auto-filled by role — customize if needed.</p>
              <ModuleChecklist selected={addForm.accessibleModules} onToggle={toggleAddModule} />
            </div>

            {addForm.accessibleModules.includes('Child Records') && (
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Child Records — Tab Access</Label>
                <p className="text-xs text-gray-400">Select which tabs this user can access inside a child's profile.</p>
                <div className="grid grid-cols-1 gap-1.5 border rounded-xl p-3 bg-blue-50/50">
                  {CHILD_RECORD_TABS.map(tab => (
                    <div
                      key={tab}
                      className="flex items-center gap-2 cursor-pointer p-1.5 rounded-lg hover:bg-white transition-colors"
                      onClick={() => toggleAddChildTab(tab)}
                    >
                      {addForm.childRecordTabs.includes(tab)
                        ? <CheckSquare className="w-4 h-4 text-blue-600 shrink-0" />
                        : <Square className="w-4 h-4 text-gray-300 shrink-0" />
                      }
                      <span className="text-sm">{tab}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button
              className="rounded-xl px-6 font-bold"
              style={{ backgroundColor: '#2F3E46', color: 'white' }}
              onClick={handleAddUser}
            >
              Create User
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── EDIT DIALOG ── */}
      <Dialog open={isEditOpen} onOpenChange={open => { if (!open) setIsEditOpen(false); }}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-[#2F3E46] font-bold">Edit User</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {editError && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" /> {editError}
              </div>
            )}

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Username *</Label>
              <Input
                value={editForm.username}
                onChange={e => setEditForm(p => ({ ...p, username: e.target.value }))}
                className="rounded-xl"
                disabled={editingUser?.role === 'centerhead'}
              />
              {editingUser?.role === 'centerhead' && (
                <p className="text-[11px] text-gray-400 italic">Center Head username cannot be changed.</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">New Password</Label>
              <div className="relative">
                <Input
                  type={showEditPassword ? 'text' : 'password'}
                  value={editForm.password}
                  onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))}
                  placeholder="Leave blank to keep current"
                  className="rounded-xl pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowEditPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  {showEditPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Role</Label>
              <Select
                value={editForm.role || undefined}
                onValueChange={handleEditRoleChange}
                disabled={editingUser?.role === 'centerhead'}
              >
                <SelectTrigger className="rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USER_ROLES.map(r => (
                    <SelectItem key={r} value={r}>{roleLabel(r)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="font-bold text-[#2F3E46]">Module Access</Label>
              <ModuleChecklist selected={editForm.accessibleModules} onToggle={toggleEditModule} />
            </div>

            {editForm.accessibleModules.includes('Child Records') && (
              <div className="space-y-1.5">
                <Label className="font-bold text-[#2F3E46]">Child Records — Tab Access</Label>
                <p className="text-xs text-gray-400">Select which tabs this user can access inside a child's profile.</p>
                <div className="grid grid-cols-1 gap-1.5 border rounded-xl p-3 bg-blue-50/50">
                  {CHILD_RECORD_TABS.map(tab => (
                    <div
                      key={tab}
                      className="flex items-center gap-2 cursor-pointer p-1.5 rounded-lg hover:bg-white transition-colors"
                      onClick={() => toggleEditChildTab(tab)}
                    >
                      {editForm.childRecordTabs.includes(tab)
                        ? <CheckSquare className="w-4 h-4 text-blue-600 shrink-0" />
                        : <Square className="w-4 h-4 text-gray-300 shrink-0" />
                      }
                      <span className="text-sm">{tab}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl" onClick={() => setIsEditOpen(false)}>Cancel</Button>
            <Button
              className="rounded-xl px-6 font-bold"
              style={{ backgroundColor: '#2F3E46', color: 'white' }}
              onClick={handleEditUser}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── DELETE DIALOG ── */}
      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent className="rounded-2xl bg-white">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-red-600">
              <AlertCircle className="w-5 h-5" /> Confirm Delete
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-3">
              <span>This will permanently delete <strong>{userToDelete?.username}</strong>.</span>
              <div className="pt-2 space-y-1.5">
                <Label className="text-xs text-gray-600">
                  Type <strong>{userToDelete?.username}</strong> to confirm:
                </Label>
                <Input
                  value={deleteConfirm}
                  onChange={e => setDeleteConfirm(e.target.value)}
                  placeholder="Username"
                  className="rounded-xl"
                />
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteConfirm('')}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleteConfirm !== userToDelete?.username}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Delete Account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
