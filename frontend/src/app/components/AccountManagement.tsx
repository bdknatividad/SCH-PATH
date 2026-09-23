import { useEffect, useRef, useState } from 'react';
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
import { createResource, deleteResource, getStore, request, updateResource } from '@/services/api';
import { useAuth } from '../state/AuthContext';
import {
  CHILD_RECORD_TAB_ORDER,
  DEFAULT_CHILD_TAB_ACCESS,
  DEFAULT_MODULE_ACCESS,
  DEFAULT_SUBMODULE_ACCESS,
  MODULE_KEYS,
  MODULE_TREE,
  SUB_MODULE_KEYS_BY_MODULE,
  canonicalizeModules,
  canonicalizeSubModuleMap,
  canonicalizeSubModules,
} from '../config/moduleAccess';
import { ROLE_KEYS, ROLE_LABELS, isFullAccessRole } from '../config/rbac';
import { passwordProblem, policy as PASSWORD_POLICY } from '@/utils/passwordPolicy';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'userAccounts';

// Roles available in Account Management. Derived from the RBAC definition so
// the page can never reference a role the backend does not support (or miss
// one it does). `admin` is excluded: it is not provisionable through this UI.
const USER_ROLES = ROLE_KEYS.filter(role => role !== 'admin');

/** Every grantable module, including the legacy key older rows may carry. */
const ALL_MODULE_GRANTS = [...MODULE_KEYS, 'Intervention Tracker'];

const DEFAULT_USERS = [
  {
    id: 'U001',
    username: 'centerhead',
    password: 'centerhead123',
    role: 'centerhead',
    accessibleModules: [...ALL_MODULE_GRANTS],
    childRecordTabs: [...CHILD_RECORD_TAB_ORDER],
    subModules: { ...(DEFAULT_SUBMODULE_ACCESS.centerhead || {}) },
    status: 'Active' as const,
    createdDate: '2025-01-01',
  },
];

// ── TYPES ────────────────────────────────────────────────────────────────────
interface User {
  id: string;
  username: string;
  displayName?: string | null;
  /**
   * Only ever set on the payload that creates an account. The API never returns
   * a hash, and `saveUsers` strips the field, so no password is held in state
   * after a save.
   */
  password?: string;
  role: string;
  accessibleModules: string[];
  childRecordTabs: string[];
  /** Per-module submenu grants — the hierarchy-aware form of `childRecordTabs`. */
  subModules: Record<string, string[]>;
  status: 'Active' | 'Inactive';
  createdDate: string;
}

interface UserForm {
  username: string;
  displayName: string;
  password: string;
  role: string;
  accessibleModules: string[];
  childRecordTabs: string[];
  subModules: Record<string, string[]>;
}

const EMPTY_FORM: UserForm = {
  username: '',
  displayName: '',
  password: '',
  role: '',
  accessibleModules: [],
  childRecordTabs: [],
  subModules: {},
};

// ── HELPERS ──────────────────────────────────────────────────────────────────
const ROLE_COLORS: Record<string, { bg: string; text: string }> = {
  centerhead:   { bg: '#FEE2E2', text: '#991B1B' },
  nurse:        { bg: '#DBEAFE', text: '#1E40AF' },
  psychologist: { bg: '#FEF3C7', text: '#92400E' },
  educator:     { bg: '#D1FAE5', text: '#065F46' },
  socialworker: { bg: '#E0E7FF', text: '#3730A3' },
  houseparent:  { bg: '#FCE7F3', text: '#9D174D' },
};

function roleLabel(role: string) {
  return ROLE_LABELS[role] || role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * Submenus to grant when a module is ticked: the role's declared set, so
 * granting a module never leaves the user with a menu that opens onto nothing.
 */
function defaultSubModulesFor(role: string, moduleName: string): string[] {
  const roleDefaults = DEFAULT_SUBMODULE_ACCESS[role];
  const fromRole = roleDefaults?.[moduleName];
  if (Array.isArray(fromRole)) return [...fromRole];
  return [...(SUB_MODULE_KEYS_BY_MODULE[moduleName] || [])];
}

/** Submenu grants for a set of modules, seeded from the role's matrix. */
function defaultsFor(modules: string[], role: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const moduleName of modules) {
    result[moduleName] = defaultSubModulesFor(role, moduleName);
  }
  return result;
}

/** The complete grant set a role starts with — modules, submenus and tabs. */
function roleGrants(role: string) {
  const modules = DEFAULT_MODULE_ACCESS[role] || ['Dashboard'];
  return {
    accessibleModules: [...modules],
    childRecordTabs: [...(DEFAULT_CHILD_TAB_ACCESS[role] || CHILD_RECORD_TAB_ORDER)],
    subModules: defaultsFor(modules, role),
  };
}

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value];
}

/**
 * Toggle a module grant and keep its submenu grants in step: granting seeds the
 * role's declared submenus so the menu never opens onto nothing, revoking drops
 * them so a revoked module cannot leave a stale grant behind.
 */
function toggleModuleGrant(form: UserForm, moduleName: string): UserForm {
  // A Center Head's Account Management grant is not revocable.
  if (form.role === 'centerhead' && moduleName === 'Account Management') return form;

  const granting = !form.accessibleModules.includes(moduleName);
  const subModules = { ...form.subModules };
  if (granting) subModules[moduleName] = defaultSubModulesFor(form.role, moduleName);
  else delete subModules[moduleName];

  return {
    ...form,
    accessibleModules: toggleInList(form.accessibleModules, moduleName),
    subModules,
  };
}

/** Toggle a single submenu grant inside a module. */
function toggleSubModuleGrant(form: UserForm, moduleName: string, subModule: string): UserForm {
  const current = form.subModules[moduleName] ?? defaultSubModulesFor(form.role, moduleName);
  const next = toggleInList(current, subModule);
  return {
    ...form,
    subModules: { ...form.subModules, [moduleName]: next },
    // `childRecordTabs` is the legacy single-module form of the same grant, so
    // it is kept in step rather than becoming a second, disagreeing source.
    childRecordTabs: moduleName === 'Child Records'
      ? canonicalizeSubModules('Child Records', next)
      : form.childRecordTabs,
  };
}

function loadUsers(): User[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_USERS;
    const parsed: User[] = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_USERS;

    // Remove stale "admin" role entry — centerhead was previously remapped to admin
    const cleaned = parsed.filter(u => u.role !== 'admin').map(u => ({
      ...u,
      accessibleModules: canonicalizeModules(u.accessibleModules),
      childRecordTabs: canonicalizeSubModules('Child Records', u.childRecordTabs, CHILD_RECORD_TAB_ORDER),
      subModules: canonicalizeSubModuleMap(u.subModules, DEFAULT_SUBMODULE_ACCESS[u.role] || {}),
    }));

    // Ensure exactly one centerhead exists
    const hasCenterhead = cleaned.some(u => u.role === 'centerhead');
    if (!hasCenterhead) return [DEFAULT_USERS[0], ...cleaned];

    return cleaned;
  } catch {
    return DEFAULT_USERS;
  }
}

function saveUsers(users: User[]) {
  // Passwords are deliberately dropped. This is a browser-side cache of what the
  // backend already holds, and the API never returns a hash — so the only thing
  // a password could ever be here is the plaintext a Center Head just typed into
  // the reset field, left readable in localStorage.
  const safe = users.map((user) => {
    const copy: Record<string, unknown> = { ...user };
    delete copy.password;
    return copy;
  });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
}

// ── COMPONENT ────────────────────────────────────────────────────────────────
export function AccountManagement() {
  const { user: currentUser, login } = useAuth();
  const [users, setUsers] = useState<User[]>(() => loadUsers());
  const [searchTerm, setSearchTerm] = useState('');
  const [filterRole, setFilterRole] = useState('all');
  const [searchArmed, setSearchArmed] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const clearSearch = () => {
    setSearchTerm('');
    requestAnimationFrame(() => {
      if (searchInputRef.current) searchInputRef.current.value = '';
    });
  };

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
          setUsers(store.users.filter((u: User) => u.role !== 'admin').map((u: User) => {
            const modules = canonicalizeModules(u.accessibleModules).length > 0
              ? canonicalizeModules(u.accessibleModules)
              : (DEFAULT_MODULE_ACCESS[u.role] || ['Dashboard']);
            return {
              ...u,
              accessibleModules: modules,
              childRecordTabs: canonicalizeSubModules('Child Records', u.childRecordTabs, CHILD_RECORD_TAB_ORDER),
              subModules: canonicalizeSubModuleMap(u.subModules, defaultsFor(modules, u.role)),
            };
          }));
        }
      } catch (err) {
        console.error('Unable to load backend users:', err);
      }
    };

    loadBackendUsers();
  }, []);

  // ── ADD ────────────────────────────────────────────────────────────────────
  const openAdd = () => {
    clearSearch();
    setSearchArmed(false);
    setAddForm(EMPTY_FORM);
    setAddError('');
    setShowAddPassword(false);
    setIsAddOpen(true);
  };

  const handleAddRoleChange = (role: string) => {
    setAddForm(prev => ({ ...prev, role, ...roleGrants(role) }));
  };

  const toggleAddModule = (mod: string) => {
    setAddForm(prev => toggleModuleGrant(prev, mod));
  };

  const toggleAddSubModule = (mod: string, sub: string) => {
    setAddForm(prev => toggleSubModuleGrant(prev, mod, sub));
  };

  const handleAddUser = async () => {
    setAddError('');
    if (!addForm.username.trim()) { setAddError('Username is required.'); return; }
    if (!addForm.password) { setAddError('Password is required.'); return; }
    if (!addForm.role) { setAddError('Please select a role.'); return; }
    // Judged by the same rule the API enforces, so the dialog cannot accept a
    // password the backend would then reject.
    const passwordIssue = passwordProblem(addForm.password, addForm.username.trim());
    if (passwordIssue) { setAddError(passwordIssue); return; }
    if (users.some(u => (u.username || '').toLowerCase() === addForm.username.trim().toLowerCase())) {
      setAddError('Username already exists.'); return;
    }

    const modules = addForm.accessibleModules.length > 0
      ? canonicalizeModules(addForm.accessibleModules)
      : (DEFAULT_MODULE_ACCESS[addForm.role] || ['Dashboard']);

    const newUser: User = {
      id: `U${String(Date.now()).slice(-4)}`,
      username: addForm.username.trim(),
      // Sent untrimmed: leading and trailing spaces are legitimate in a password.
      password: addForm.password,
      role: addForm.role,
      accessibleModules: modules,
      childRecordTabs: addForm.childRecordTabs.length > 0
        ? addForm.childRecordTabs
        : [...CHILD_RECORD_TAB_ORDER],
      subModules: canonicalizeSubModuleMap(addForm.subModules, defaultsFor(modules, addForm.role)),
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
    clearSearch();
    setSearchArmed(false);
    setEditingUser(user);
    const modules = [...user.accessibleModules];
    setEditForm({
      username: user.username,
      displayName: user.displayName || '',
      password: '',
      role: user.role,
      accessibleModules: modules,
      childRecordTabs: [...(user.childRecordTabs || CHILD_RECORD_TAB_ORDER)],
      subModules: canonicalizeSubModuleMap(user.subModules, defaultsFor(modules, user.role)),
    });
    setEditError('');
    setShowEditPassword(false);
    setIsEditOpen(true);
  };

  const handleEditRoleChange = (role: string) => {
    setEditForm(prev => ({ ...prev, role, ...roleGrants(role) }));
  };

  const toggleEditModule = (mod: string) => {
    setEditForm(prev => toggleModuleGrant(prev, mod));
  };

  const toggleEditSubModule = (mod: string, sub: string) => {
    setEditForm(prev => toggleSubModuleGrant(prev, mod, sub));
  };

  const handleEditUser = async () => {
    setEditError('');
    if (!editForm.username.trim()) { setEditError('Username is required.'); return; }
    if (!editingUser) return;

    const conflict = users.find(
      u => (u.username || '').toLowerCase() === editForm.username.trim().toLowerCase() && u.id !== editingUser.id
    );
    if (conflict) { setEditError('Username already taken.'); return; }

    // Only judged when a new password is actually being set — leaving the field
    // blank means "keep the current one", which is not a password at all.
    const newPassword = editForm.password;
    if (newPassword) {
      const passwordIssue = passwordProblem(newPassword, editForm.username.trim());
      if (passwordIssue) { setEditError(passwordIssue); return; }
    }

    const updated = users.map(u => {
      if (u.id !== editingUser.id) return u;
      const modules = editForm.accessibleModules.length > 0
        ? canonicalizeModules(editForm.accessibleModules)
        : (DEFAULT_MODULE_ACCESS[editForm.role] || ['Dashboard']);
      return {
        ...u,
        username: editForm.username.trim(),
        displayName: editForm.displayName.trim() || null,
        role: editForm.role,
        accessibleModules: modules,
        childRecordTabs: editForm.childRecordTabs.length > 0
          ? editForm.childRecordTabs
          : [...CHILD_RECORD_TAB_ORDER],
        subModules: canonicalizeSubModuleMap(editForm.subModules, defaultsFor(modules, editForm.role)),
      };
    });

    try {
      const savedUser = updated.find(u => u.id === editingUser.id) as User;
      // Save identity/account fields only when they actually changed.  A
      // module-only edit goes straight to the dedicated access endpoint, so
      // legacy user-name fields cannot block permission changes.
      // Keep permission edits completely separate from the legacy user-update
      // endpoint.  In older databases that endpoint can still encounter a
      // retired fullName field.  Module Access must never depend on that path.
      // The dedicated access endpoint also accepts displayName safely when it
      // is changed in the same dialog.
      const identityChanged =
        savedUser.username !== editingUser.username ||
        savedUser.role !== editingUser.role ||
        Boolean(newPassword);

      if (identityChanged) {
        await updateResource<User>('users', editingUser.id, {
          username: savedUser.username,
          ...(newPassword ? { password: newPassword } : {}),
          role: savedUser.role,
          status: savedUser.status,
        });
      }

      // The access endpoint answers with the account as it is now stored, so the
      // list shows what the database actually holds instead of this component's
      // own derivation of it. The two could otherwise disagree silently — the
      // server canonicalizes and rewrites the grants, the dialog only guesses.
      const accessResponse = await request<{ success: boolean; data: User }>(
        `/users/${editingUser.id}/access`,
        {
          method: 'PUT',
          body: JSON.stringify({
            accessibleModules: savedUser.accessibleModules,
            childRecordTabs: savedUser.childRecordTabs,
            // The hierarchy-aware grant. Sent alongside the legacy flat tab list
            // so the API stores one consistent answer.
            subModules: savedUser.subModules,
            displayName: savedUser.displayName || null,
          }),
        },
      );

      const persisted = accessResponse?.data;
      const reconciled = persisted
        ? updated.map(u => (u.id === editingUser.id ? { ...u, ...persisted } : u))
        : updated;

      setUsers(reconciled);
      saveUsers(reconciled);

      // If the edited user is the currently logged-in user, refresh their session
      const editedUser = reconciled.find(u => u.id === editingUser.id);
      if (editedUser && currentUser && editedUser.username === currentUser.username) {
        const savedToken = localStorage.getItem('token') || '';
        login(
          editedUser.username,
          editedUser.role,
          editedUser.accessibleModules,
          savedToken,
          editedUser.childRecordTabs,
          editedUser.displayName,
          { subModules: editedUser.subModules },
        );
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
    const q = searchTerm.trim().toLowerCase();
    const matchSearch = !q || (u.displayName || '').toLowerCase().includes(q);
    const matchRole = filterRole === 'all' || u.role === filterRole;
    return matchSearch && matchRole;
  });

  // ── MODULE CHECKLIST ────────────────────────────────────────────────────────
  /**
   * The grant editor. It renders the canonical RBAC hierarchy — every module,
   * with its submenus nested underneath — so an operator grants exactly the
   * menus and submenus the definition declares and nothing has to be kept in
   * sync by hand.
   *
   * For a full-access role the grants are shown as fixed and locked: that role
   * bypasses every check, so editing them would be a lie.
   */
  function ModuleChecklist({
    selected,
    role,
    subModules,
    onToggle,
    onToggleSubModule,
  }: {
    selected: string[];
    role: string;
    subModules: Record<string, string[]>;
    onToggle: (mod: string) => void;
    onToggleSubModule: (mod: string, sub: string) => void;
  }) {
    const locked = isFullAccessRole(role);

    return (
      <div className="grid grid-cols-1 gap-1 border rounded-xl p-3 bg-gray-50">
        {MODULE_TREE.map(mod => {
          const granted = locked || selected.includes(mod.key);
          const grantedSubModules = locked
            ? SUB_MODULE_KEYS_BY_MODULE[mod.key] || []
            : (subModules[mod.key] ?? defaultSubModulesFor(role, mod.key));

          return (
            <div key={mod.key}>
              <button
                type="button"
                disabled={locked}
                className={`flex w-full items-center gap-2 rounded-lg p-1.5 text-left transition-colors ${
                  locked ? 'cursor-default' : 'cursor-pointer hover:bg-white'
                }`}
                onClick={() => onToggle(mod.key)}
              >
                {granted
                  ? <CheckSquare className="w-4 h-4 text-[#2F3E46] shrink-0" />
                  : <Square className="w-4 h-4 text-gray-300 shrink-0" />
                }
                <span className="text-sm">{mod.label}</span>
                {mod.subModules.length > 0 && (
                  <span className="ml-auto text-[10px] font-mono text-gray-400">
                    {grantedSubModules.length}/{mod.subModules.length}
                  </span>
                )}
              </button>

              {/* SUBMENUS */}
              {granted && mod.subModules.length > 0 && (
                <div className="ml-6 mb-1 space-y-0.5 border-l border-gray-200 pl-2">
                  {mod.subModules.map(sub => {
                    const subGranted = grantedSubModules.includes(sub.key);
                    return (
                      <button
                        key={sub.key}
                        type="button"
                        disabled={locked}
                        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors ${
                          locked ? 'cursor-default' : 'cursor-pointer hover:bg-white'
                        }`}
                        onClick={() => onToggleSubModule(mod.key, sub.key)}
                      >
                        {subGranted
                          ? <CheckSquare className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                          : <Square className="w-3.5 h-3.5 text-gray-300 shrink-0" />
                        }
                        <span className="text-xs text-gray-700">{sub.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
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
              ref={searchInputRef}
              className="pl-10 rounded-xl"
              placeholder="Search by name..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              onFocus={() => setSearchArmed(true)}
              onBlur={() => { if (!searchTerm) setSearchArmed(false); }}
              type="search"
              name="account-management-name-filter"
              id="account-management-name-filter"
              autoComplete="new-password"
              inputMode="search"
              readOnly={!searchArmed}
              spellCheck={false}
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
                        <p className="font-bold text-[#2F3E46]">{user.displayName || user.username}</p>
                        <p className="text-[10px] text-gray-400 font-mono">
                          {user.displayName ? user.username : user.id}
                        </p>
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
      <Dialog open={isAddOpen} onOpenChange={open => { if (!open) { setIsAddOpen(false); setSearchTerm(''); } }}>
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
              <p className="text-[11px] text-gray-400">
                At least {PASSWORD_POLICY.minLength} characters, and not the same as the username.
              </p>
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
              <p className="text-xs text-gray-400">
                Auto-filled by role — customize if needed. Submenus appear under each granted module.
              </p>
              <ModuleChecklist
                selected={addForm.accessibleModules}
                role={addForm.role}
                subModules={addForm.subModules}
                onToggle={toggleAddModule}
                onToggleSubModule={toggleAddSubModule}
              />
              {isFullAccessRole(addForm.role) && (
                <p className="text-[11px] text-gray-400 italic">
                  {roleLabel(addForm.role)} has full system access and bypasses every permission check.
                </p>
              )}
            </div>
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
      <Dialog open={isEditOpen} onOpenChange={open => { if (!open) { setIsEditOpen(false); setSearchTerm(''); } }}>
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
              <Label className="font-bold text-[#2F3E46]">Display Name</Label>
              <Input
                value={editForm.displayName}
                onChange={e => setEditForm(p => ({ ...p, displayName: e.target.value }))}
                placeholder={editForm.username || 'e.g. Juan Dela Cruz'}
                className="rounded-xl"
              />
              <p className="text-[11px] text-gray-400">
                Optional. Shown everywhere instead of the username (e.g. in the Houseparent dropdown and Case Load) — the username itself stays fixed for login and ordering.
              </p>
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
              <p className="text-[11px] text-gray-400">
                Leave blank to keep the current password. At least {PASSWORD_POLICY.minLength} characters,
                and not the same as the username.
              </p>
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
              <p className="text-xs text-gray-400">
                Submenus appear under each granted module.
              </p>
              <ModuleChecklist
                selected={editForm.accessibleModules}
                role={editForm.role}
                subModules={editForm.subModules}
                onToggle={toggleEditModule}
                onToggleSubModule={toggleEditSubModule}
              />
              {isFullAccessRole(editForm.role) && (
                <p className="text-[11px] text-gray-400 italic">
                  {roleLabel(editForm.role)} has full system access and bypasses every permission check.
                </p>
              )}
            </div>
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
