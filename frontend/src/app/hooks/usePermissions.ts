/**
 * `usePermissions()` — the single way a component asks "may I?".
 *
 * It reads the caller's effective access and exposes it as plain booleans. The
 * snapshot comes from the server when the session carries one
 * (`GET /api/rbac/me`, or the login payload) and is resolved locally only as a
 * fallback — so the UI renders the same answer the API will enforce.
 *
 * @example
 * const { can, canOpenSubModule } = usePermissions();
 * {can('Violations', 'verify') && <VerifyButton />}
 */

import { useMemo } from 'react';
import { useAuth } from '../state/AuthContext';
import {
  PERMISSION_KEYS,
  accessForUser,
  listAccessibleMenus,
  permissionsFor as permissionsForSubject,
  userCan,
  type AccessibleMenu,
  type AccessSnapshot,
} from '../config/moduleAccess';
import { roleLabel as roleLabelFor } from '../config/rbac';

export interface PermissionsApi {
  /** The resolved snapshot every check reads. */
  access: AccessSnapshot;
  /** True when the role bypasses all permission checks (Center Head). */
  fullAccess: boolean;
  role: string;
  roleLabel: string;
  /** The menu tree already filtered to what this account may see. */
  menus: AccessibleMenu[];
  /**
   * Capability check. Omit `permission` to test module access alone; add
   * `subModule` to test a submenu.
   */
  can: (module?: string | null, permission?: string | null, subModule?: string | null) => boolean;
  canOpenModule: (module?: string | null) => boolean;
  canOpenSubModule: (module?: string | null, subModule?: string | null) => boolean;
  /** Every permission this account holds on a module. */
  permissionsFor: (module?: string | null) => string[];
  /** Every permission key, for rendering an access matrix. */
  allPermissions: readonly string[];
}

export function usePermissions(): PermissionsApi {
  const { user } = useAuth();

  return useMemo<PermissionsApi>(() => {
    const access = accessForUser(user);

    return {
      access,
      fullAccess: access.fullAccess,
      role: access.role,
      roleLabel: roleLabelFor(access.role),
      // Prefer the tree the server already filtered; derive it only when the
      // session did not carry one.
      menus: access.menus ?? listAccessibleMenus(access),
      can: (module, permission, subModule) => userCan(user, module, permission, subModule),
      canOpenModule: (module) => userCan(user, module, null),
      canOpenSubModule: (module, subModule) =>
        userCan(user, module, null, subModule ?? undefined),
      permissionsFor: (module) => permissionsForSubject(access, module),
      allPermissions: PERMISSION_KEYS,
    };
  }, [user]);
}

export default usePermissions;
