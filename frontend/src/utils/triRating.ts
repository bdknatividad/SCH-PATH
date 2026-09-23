// src/utils/triRating.ts
//
// The TRI adjectival rating bands, in order, plus the trend comparison used by the
// child record page and the TRI record view.
//
// The band order lives here once. It was previously implicit in a chain of `>=`
// comparisons inside Tri.tsx, which meant any other screen wanting to say "this got
// better" had to re-derive it — and the two Dashboard cards already demonstrate how
// easily a duplicated rating rule drifts apart.

/**
 * Official TRI bands, lowest to highest. Thresholds (Part I minus Part II
 * deductions): >=451 Very Good, >=301 Good, >=151 Fair, >=1 Needs Improvement.
 */
export const TRI_RATING_ORDER = ['Needs Improvement', 'Fair', 'Good', 'Very Good'] as const;

export type TriRating = (typeof TRI_RATING_ORDER)[number];

/** Position of a rating in the band order, or null when it is missing/unrecognised. */
export function ratingRank(rating?: string | null): number | null {
  if (!rating) return null;
  const index = TRI_RATING_ORDER.indexOf(rating as TriRating);
  return index === -1 ? null : index;
}

export type TriTrendDirection = 'improved' | 'declined' | 'unchanged' | 'unknown';

/**
 * The adjectival band a score falls into, or null below the lowest threshold.
 * Mirrors the backend's `TRI_SCORING` bands so a score cannot read one way in the
 * form and another way in the stored record.
 */
export function ratingForPoints(points: number | null | undefined): TriRating | null {
  const n = Number(points);
  if (!Number.isFinite(n)) return null;
  if (n >= 451) return 'Very Good';
  if (n >= 301) return 'Good';
  if (n >= 151) return 'Fair';
  if (n >= 1) return 'Needs Improvement';
  return null;
}

export interface TriTrend {
  direction: TriTrendDirection;
  /** current − previous, or null when either side is unknown. */
  pointsDelta: number | null;
  fromRating: string | null;
  toRating: string | null;
  fromPoints: number | null;
  toPoints: number | null;
  /** Short human-readable form, e.g. "Fair → Good  ▲ 32 pts". Empty when unknown. */
  label: string;
}

const numOrNull = (value: unknown): number | null => {
  // `Number(null)` and `Number('')` are both 0, which would turn "no previous
  // record" into a previous score of zero — and therefore report every first TRI
  // as a huge improvement. Treat absent values as absent.
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Compare a TRI result against the resident's previous finalized TRI.
 *
 * Direction follows the adjectival band when both ratings are known, because that
 * band is what the facility actually reports; it falls back to raw points when a
 * rating is missing (a record can be Finalized with 0 points, which has no band).
 */
export function triTrend(
  current: { rating?: string | null; finalPoints?: number | null },
  previous: { rating?: string | null; finalPoints?: number | null } | null | undefined
): TriTrend {
  const empty: TriTrend = {
    direction: 'unknown', pointsDelta: null,
    fromRating: null, toRating: null, fromPoints: null, toPoints: null, label: '',
  };
  if (!previous) return empty;

  const fromRating = previous.rating ?? null;
  const toRating = current.rating ?? null;
  const fromPoints = numOrNull(previous.finalPoints);
  const toPoints = numOrNull(current.finalPoints);

  const fromRank = ratingRank(fromRating);
  const toRank = ratingRank(toRating);

  let direction: TriTrendDirection = 'unknown';
  if (fromRank !== null && toRank !== null) {
    direction = toRank > fromRank ? 'improved' : toRank < fromRank ? 'declined' : 'unchanged';
  } else if (fromPoints !== null && toPoints !== null) {
    direction = toPoints > fromPoints ? 'improved' : toPoints < fromPoints ? 'declined' : 'unchanged';
  }

  const pointsDelta = fromPoints !== null && toPoints !== null ? toPoints - fromPoints : null;

  let label = '';
  if (direction !== 'unknown') {
    const arrow = direction === 'improved' ? '▲' : direction === 'declined' ? '▼' : '=';
    const bands = fromRating && toRating ? `${fromRating} → ${toRating}  ` : '';
    const delta = pointsDelta === null ? '' : pointsDelta === 0 ? 'no change' : `${pointsDelta > 0 ? '+' : ''}${pointsDelta} pts`;
    label = `${bands}${arrow}${delta ? ' ' + delta : ''}`.trim();
  }

  return { direction, pointsDelta, fromRating, toRating, fromPoints, toPoints, label };
}
