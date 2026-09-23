/**
 * `useSubModuleTabs()` — the tab strip a page should render.
 *
 * A module's tabs *are* its submodules, and the RBAC definition already says who
 * may open each one. Components used to decide for themselves with hardcoded
 * role checks (`isCenterHead ? [...] : [...]`), which was wrong in both
 * directions at once: it hid "Manage Violations & Interventions" from a
 * Psychologist the matrix grants it to, and it offered the Documents "Pending
 * Review" tab to roles with no approval authority. Asking the definition means
 * the strip and the enforced matrix cannot disagree.
 *
 * Tabs come back in the definition's order, carrying the definition's label and
 * its `?tab=` slug. A page then uses the slugs as its own local tab keys, so the
 * deep links notifications already emit keep working.
 *
 * @example
 * const tabs = useSubModuleTabs('Documents');
 * const [activeTab, setActiveTab] = useSubModuleTab(
 *   tabs.map((tab) => tab.key) as readonly string[],
 *   tabs[0].key,
 * );
 */

import { useMemo } from 'react';
import { MODULE_TREE } from '../config/rbac';
import { usePermissions } from './usePermissions';

export interface SubModuleTab {
  /** The `?tab=` slug, which is also the page's local tab key. */
  key: string;
  label: string;
  /** The submodule key this tab belongs to, for a finer-grained check. */
  subModule: string;
}

/**
 * The tabs of `module` the caller may open, in definition order.
 *
 * Returns `[]` for a module with no submodules (Dashboard, Assessments, …) and
 * for a module the caller does not hold at all — a page must render no strip in
 * that case rather than an empty one.
 */
export function useSubModuleTabs(module: string): SubModuleTab[] {
  const { canOpenSubModule } = usePermissions();

  return useMemo(() => {
    const definition = MODULE_TREE.find((entry) => entry.key === module);
    if (!definition) return [];

    return definition.subModules
      .filter((sub) => Boolean(sub.tab) && canOpenSubModule(module, sub.key))
      .map((sub) => ({ key: sub.tab as string, label: sub.label, subModule: sub.key }));
  }, [module, canOpenSubModule]);
}

export default useSubModuleTabs;
