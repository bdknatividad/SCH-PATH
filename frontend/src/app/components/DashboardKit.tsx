/**
 * The shared building blocks of a role dashboard.
 *
 * The Psychologist, Nurse and Educator pages each hand-rolled the same three
 * shapes — a dark banner, a row of counter tiles, and a titled card with an
 * empty state — so a fourth and fifth copy would have been the point at which
 * "consistent" stopped being true. These are those shapes, once.
 *
 * Deliberately presentational: no data fetching, no role checks, no links of
 * their own. A dashboard decides what a tile counts and where it goes; this
 * file only decides what a tile looks like. That is what keeps every role's
 * page recognisably the same application while its content differs.
 *
 * Two rules the callers depend on:
 *
 *  - `StatTile` renders the whole card as a button when it has an `onClick`,
 *    so a tile is a tap target on a phone rather than a small "view" link.
 *  - `SectionCard` always renders *something*: when there is nothing to show it
 *    prints `empty`, because a card that collapses to a bare heading reads as a
 *    loading failure. Every list on every dashboard passes one.
 */

import type { ComponentType, ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/app/components/ui/card';
import { Badge } from '@/app/components/ui/badge';
import { cn } from '@/app/components/ui/utils';

/** The SCH-PATH header band: dark slate, yellow underline. */
export function DashboardHeader({
  title,
  displayRole,
  subtitle,
}: {
  title: string;
  displayRole: string;
  subtitle: string;
}) {
  return (
    <div className="bg-[#2F3E46] p-5 sm:p-6 rounded-xl shadow-md border-b-4 border-[#FFD100]">
      <h2 className="text-xl sm:text-2xl font-bold mb-1 text-white">{title}</h2>
      <p className="text-sm sm:text-base text-gray-300">
        Welcome back,{' '}
        <span className="font-bold text-[#FFD100] uppercase">{displayRole}</span>
        <span className="text-gray-400 text-sm ml-2">— {subtitle}</span>
      </p>
    </div>
  );
}

/**
 * One counter in the strip.
 *
 * `value` is a string so a caller can pass `'…'` while a figure is still being
 * read, rather than rendering a `0` that is about to become something else.
 */
export function StatTile({
  title,
  value,
  caption,
  icon: Icon,
  onClick,
}: {
  title: string;
  value: string | number;
  caption?: string;
  icon: ComponentType<{ className?: string }>;
  onClick?: () => void;
}) {
  const interactive = typeof onClick === 'function';

  return (
    <Card
      className={cn(
        'border-none shadow-sm',
        interactive &&
          'cursor-pointer hover:shadow-md hover:ring-2 hover:ring-[#FFD100] active:scale-95 transition-all',
      )}
      onClick={onClick}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      <CardContent className="p-3 sm:p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[11px] sm:text-xs font-medium text-gray-500 uppercase tracking-wide">
              {title}
            </p>
            <p className="text-2xl sm:text-3xl font-bold mt-1 text-[#2F3E46]">{value}</p>
            {caption && <p className="text-[10px] text-gray-400 mt-0.5">{caption}</p>}
          </div>
          <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center bg-[#FFD100]/20 shrink-0">
            <Icon className="w-4 h-4 sm:w-5 sm:h-5 text-[#2F3E46]" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** The strip of tiles. Two per row on a phone, four from `lg`. */
export function StatTileRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{children}</div>;
}

/**
 * A titled card with an optional count badge and an optional header action.
 *
 * `empty` is rendered in place of `children` when `isEmpty` is true — callers
 * pass their own sentence, because "No pending documents." and "Nothing
 * scheduled today." are different statements and a generic "No data" tells the
 * reader nothing.
 */
export function SectionCard({
  title,
  icon,
  badge,
  action,
  isEmpty = false,
  empty,
  children,
  className,
}: {
  title: string;
  icon?: ReactNode;
  badge?: number;
  action?: ReactNode;
  isEmpty?: boolean;
  empty?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('border-none shadow-sm', className)}>
      <CardHeader className="border-b border-gray-100 pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold text-[#2F3E46]">
            {icon}
            {title}
            {badge !== undefined && badge > 0 && (
              <Badge className="bg-[#FFD100] text-[#2F3E46] text-[10px] px-1.5 py-0">{badge}</Badge>
            )}
          </CardTitle>
          {action}
        </div>
      </CardHeader>
      <CardContent className="pt-3">
        {isEmpty ? <EmptyState>{empty}</EmptyState> : children}
      </CardContent>
    </Card>
  );
}

/** The one way a list says it has nothing to say. */
export function EmptyState({ children }: { children?: ReactNode }) {
  return <p className="text-xs text-gray-400 italic text-center py-4">{children}</p>;
}

/**
 * A row inside a `SectionCard` list.
 *
 * `to` is a path the caller has already established the role may open — this
 * component does not check, because it cannot see the caller's access. A path
 * into a module the role does not hold is a dead control, so the check belongs
 * at the call site where the role is known.
 */
export function ListRow({
  title,
  meta,
  trailing,
  onClick,
}: {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
}) {
  const interactive = typeof onClick === 'function';
  const Wrapper = interactive ? 'button' : 'div';

  return (
    <Wrapper
      type={interactive ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'w-full flex items-center justify-between gap-3 p-2.5 rounded-lg border border-gray-100 text-left',
        interactive && 'hover:bg-gray-50 transition-colors',
      )}
    >
      <div className="min-w-0">
        <div className="text-xs font-semibold text-[#2F3E46] truncate">{title}</div>
        {meta && <div className="text-[10px] text-gray-400 mt-0.5">{meta}</div>}
      </div>
      {trailing && <div className="shrink-0">{trailing}</div>}
    </Wrapper>
  );
}
