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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useSubModuleTab<T extends string>(
  allowed: readonly T[],
  fallback: T,
): readonly [T, (next: T) => void] {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const fromUrl = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : null;

  const [active, setActive] = useState<T>(fromUrl ?? fallback);

  /**
   * The URL is applied when it **changes**, not whenever it disagrees with the
   * selected tab.
   *
   * The effect here used to depend on `active` as well, which turned a deep link
   * into a lock: arriving at `/violations?tab=list` and then choosing any other
   * tab re-ran the effect, found the URL still saying `list`, and put the tab
   * straight back. Only the tab the link named could ever be reached. Reported
   * as "I can navigate through all tabs, but coming from the dashboard's Active
   * Violations tile the other three will not open" — and it affected every
   * `?tab=` entry point, not just that one.
   *
   * Remembering the last URL value acted on keeps both halves working: a link
   * still lands on the tab it names, and a click afterwards is no longer undone.
   */
  const appliedUrlTab = useRef<string | null>(fromUrl);
  useEffect(() => {
    if (fromUrl && fromUrl !== appliedUrlTab.current) {
      appliedUrlTab.current = fromUrl;
      setActive(fromUrl);
    }
  }, [fromUrl]);

  const select = useCallback((next: T) => setActive(next), []);

  return [active, select] as const;
}

export default useSubModuleTab;
