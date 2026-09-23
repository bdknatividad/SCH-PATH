/**
 * `useSubModuleTab()` — let a deep link drive a page's tabs.
 *
 * The sidebar no longer has submenus: a module's submodules are reached only
 * through the tab strip rendered inside that module. This hook survives
 * because `?tab=<key>` is still a real entry point — notifications and
 * cross-module buttons link to it (e.g. `/children/:id?tab=medical`,
 * `/reports?tab=review`, `/violations?tab=interventions`), and a page that has
 * tabs adopts this hook so the link lands on the right one.
 *
 * The URL is an *input* only: selecting a tab in the page does not rewrite it.
 * That keeps the behaviour of every existing tab strip exactly as it was.
 *
 * @example
 * const [activeTab, setActiveTab] = useSubModuleTab(['list', 'verification'] as const, 'list');
 */

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useSubModuleTab<T extends string>(
  allowed: readonly T[],
  fallback: T,
): readonly [T, (next: T) => void] {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const fromUrl = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;

  const [active, setActive] = useState<T>(fromUrl ?? fallback);

  // Follow a submenu click while this page is already mounted. Setting `active`
  // to `fromUrl` makes the two equal, so this settles after one pass.
  useEffect(() => {
    if (fromUrl && fromUrl !== active) setActive(fromUrl);
  }, [fromUrl, active]);

  const select = useCallback((next: T) => setActive(next), []);

  return [active, select] as const;
}

export default useSubModuleTab;
