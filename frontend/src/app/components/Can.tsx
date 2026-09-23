/**
 * `<Can>` — declarative capability gate.
 *
 * Renders `children` only when the caller holds the capability. Prefer this
 * over hand-rolled `user.role === '…'` tests: the rule lives in the RBAC
 * definition, so adding a role never means revisiting a component.
 *
 * The server computes the same answer, so a control that renders is a control
 * the API will accept. Never AND this with a client-side ownership test — a
 * reviewer who can edit everything would be hidden from their own control.
 *
 * @example
 * <Can module="Violations" permission="verify">
 *   <VerifyButton />
 * </Can>
 *
 * @example // submenu-gated control
 * <Can module="Documents" subModule="Pending Review">
 *   <PendingQueue />
 * </Can>
 */

import type { ReactNode } from 'react';
import { usePermissions } from '../hooks/usePermissions';

interface CanProps {
  /** Canonical module key, e.g. 'Violations'. */
  module?: string | null;
  /** Permission key or label. Omit to gate on module/submenu access alone. */
  permission?: string | null;
  /** Submenu key, e.g. 'Pending Review'. */
  subModule?: string | null;
  children: ReactNode;
  /** Rendered when the capability is absent. Defaults to nothing. */
  fallback?: ReactNode;
}

export function Can({ module, permission, subModule, children, fallback = null }: CanProps) {
  const { can } = usePermissions();
  return <>{can(module, permission, subModule) ? children : fallback}</>;
}

export default Can;
