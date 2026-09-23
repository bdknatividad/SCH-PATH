/**
 * TRI scoring bands.
 *
 * The official scheme from the TRI PDF (page 8): 451–600 Very Good, 301–450 Good,
 * 151–300 Fair, 1–150 Needs Improvement. Boundaries are inclusive on the lower
 * bound, so 450 is Good and 451 is Very Good.
 *
 * This lived inside triController.js. It moved here so the PDF writer can label the
 * summary block without a second copy of the thresholds — the frontend keeps its own
 * matching copy in `src/utils/triRating.ts`, and a test cross-checks the two.
 */

const TRI_SCORING = {
  NEEDS_IMPROVEMENT: { max: 150, label: 'Needs Improvement' },
  FAIR: { min: 151, max: 300, label: 'Fair' },
  GOOD: { min: 301, max: 450, label: 'Good' },
  VERY_GOOD: { min: 451, max: 600, label: 'Very Good' },
};

/** Each Part I item is scored 1–4. Max total (150 items × 4) = 600 points. */
const MAX_TRI_PART_ONE_POINTS = 600;

/** The adjectival band for a final score, or null below the lowest threshold. */
function ratingForPoints(finalPoints) {
  const points = Number(finalPoints);
  if (!Number.isFinite(points)) return null;
  if (points >= TRI_SCORING.VERY_GOOD.min) return TRI_SCORING.VERY_GOOD.label;
  if (points >= TRI_SCORING.GOOD.min) return TRI_SCORING.GOOD.label;
  if (points >= TRI_SCORING.FAIR.min) return TRI_SCORING.FAIR.label;
  if (points >= 1) return TRI_SCORING.NEEDS_IMPROVEMENT.label;
  return null;
}

module.exports = { TRI_SCORING, MAX_TRI_PART_ONE_POINTS, ratingForPoints };
