/**
 * Expected fantasy points for one player on one scoring period.
 *
 *   expected points = P(plays) x blended fantasy points per game
 *
 * ESPN already scores each stat split with the league's own scoring settings
 * (`appliedAverage`), so no scoring weights are needed here. The blend leans on
 * recent form but keeps season and preseason-projection terms to damp small
 * samples (early season, a hot week, a role change that has not stuck yet).
 *
 * All constants below are tunable guesses, not fitted values.
 */

/** Chance a player suits up, by injury status. Unknown statuses count as healthy. */
export const P_PLAY = {
  ACTIVE: 1,
  PROBABLE: 0.95,
  DAY_TO_DAY: 0.6,
  QUESTIONABLE: 0.5,
  DOUBTFUL: 0.15,
  OUT: 0,
  SUSPENSION: 0,
  INJURY_RESERVE: 0,
};

/** Blend weights over the splits the normalizer extracts. Renormalized over what is available. */
export const SPLIT_WEIGHTS = {
  last7: 0.2,
  last15: 0.2,
  last30: 0.15,
  season: 0.25,
  projected: 0.2,
};

/**
 * Used when a player has no usable stats at all. Small but positive, so healthy
 * players with a game still start (ordering then falls back to current slots)
 * instead of the whole roster scoring 0 and being benched.
 */
export const FALLBACK_FP = 1;

/**
 * @param {{last7?: number, last15?: number, last30?: number, season?: number, projected?: number}} fp
 * @returns {number|null} blended fantasy points per game, or null if no split is available
 */
export function blendedFpPerGame(fp) {
  if (!fp) return null;
  let num = 0;
  let den = 0;
  for (const [key, w] of Object.entries(SPLIT_WEIGHTS)) {
    const v = fp[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      num += w * v;
      den += w;
    }
  }
  return den > 0 ? num / den : null;
}

/**
 * Probability the player plays.
 * Future days: injury status is unknowable, so only OUT-style statuses carry forward
 * (matching the bot's existing rule that an OUT player stays out until re-run).
 */
export function playProbability(injuryStatus, isToday) {
  const status = String(injuryStatus ?? 'ACTIVE').toUpperCase();
  const p = P_PLAY[status] ?? 1;
  if (p === 0) return 0;
  return isToday ? p : 1;
}

/**
 * @param {object} player            normalized player (needs injuryStatus, fpAverages)
 * @param {{ playsToday: boolean, isToday: boolean }} ctx
 */
export function expectedPoints(player, { playsToday, isToday }) {
  if (!playsToday) return 0;
  const p = playProbability(player.injuryStatus, isToday);
  if (p === 0) return 0;
  return p * (blendedFpPerGame(player.fpAverages) ?? FALLBACK_FP);
}
