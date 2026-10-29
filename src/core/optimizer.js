/**
 * Per-day lineup optimizer.
 *
 * Each rostered player gets an expected-points score for the period
 * (see projection.js): P(plays) x blended fantasy points per game, and 0 if his
 * team has no game. Starting slots are then filled with the assignment that
 * maximizes total expected points, respecting ESPN's per-player slot eligibility
 * (so multi-position players and the G / F / UTIL flex slots are handled jointly,
 * not one slot at a time).
 *
 * Players with 0 expected points (no game, or ruled out) are never started.
 * A slot with no eligible candidate stays empty.
 */

import { SLOT, isEligibleForSlot } from '../utils/slot-utils.js';
import { expectedPoints } from './projection.js';
import { minCostAssignment } from './assignment.js';

/** Ineligible slot/player pairs cost this much; the empty-slot columns always beat it. */
const INELIGIBLE = 1e6;
/** Nudge toward leaving a player where he already is, so ties don't churn transactions. */
const STAY_BONUS = 0.05;

/**
 * Build lineup items for a single scoring period.
 *
 * @param {Player[]} activePlayers  — rostered players NOT in IR slots
 * @param {Player[]} irPlayers      — players assigned to IR slots
 * @param {Set<number>} playingTeamIds — pro team IDs with games today
 * @param {number} scoringPeriodId
 * @param {number} currentScoringPeriodId — periods beyond this are future days (IR untouchable)
 * @param {Map<number, number>} currentSlots — playerId → current lineupSlotId for this period
 * @param {number[]} activeSlots — league-derived starting slots in fill order (required)
 * @returns {LineupItem[]}
 */
export function optimizeLineup(activePlayers, irPlayers, playingTeamIds, scoringPeriodId, currentScoringPeriodId, currentSlots = new Map(), activeSlots) {
  const currentSlotOf = player => currentSlots.get(player.playerId) ?? player.lineupSlotId;
  // ESPN rejects IR transactions on future days, so a player already in IR there is untouchable.
  const isFutureIr = slotId => scoringPeriodId > currentScoringPeriodId && slotId === SLOT.IR;
  const isToday = scoringPeriodId <= currentScoringPeriodId;

  const scored = activePlayers.map(p => ({
    ...p,
    expected: expectedPoints(p, { playsToday: playingTeamIds.has(p.proTeamId), isToday }),
  }));

  // Only players expected to score, and not stuck on a future-day IR slot, compete for starting slots.
  const candidates = scored.filter(p => p.expected > 0 && !isFutureIr(currentSlotOf(p)));

  const assignments = []; // { slotId, player } — array so multiple same-slotId entries survive
  const usedPlayerIds = new Set();

  const slotCount = activeSlots.length;
  if (slotCount > 0 && candidates.length > 0) {
    // Columns: every candidate, then one "leave this slot empty" column per slot (cost 0).
    const cols = candidates.length + slotCount;
    const cost = activeSlots.map(slotId => {
      const row = new Array(cols).fill(0);
      candidates.forEach((player, j) => {
        if (!isEligibleForSlot(player, slotId)) {
          row[j] = INELIGIBLE;
          return;
        }
        const stay = currentSlotOf(player) === slotId ? STAY_BONUS : 0;
        row[j] = -(player.expected + stay);
      });
      return row;
    });

    const rowToCol = minCostAssignment(cost);
    rowToCol.forEach((col, row) => {
      if (col < 0 || col >= candidates.length) return; // empty-slot column
      const player = candidates[col];
      if (cost[row][col] >= INELIGIBLE) return;
      assignments.push({ slotId: activeSlots[row], player });
      usedPlayerIds.add(player.playerId);
    });
  }

  const items = [];

  // Active slot assignments
  for (const { slotId: toSlotId, player } of assignments) {
    items.push({
      playerId: player.playerId,
      type: 'LINEUP',
      fromLineupSlotId: currentSlotOf(player),
      toLineupSlotId: toSlotId,
    });
  }

  // Bench: unassigned active players
  for (const player of scored) {
    if (usedPlayerIds.has(player.playerId)) continue;
    if (isFutureIr(currentSlotOf(player))) continue; // stuck on IR for a future day — leave them there
    items.push({
      playerId: player.playerId,
      type: 'LINEUP',
      fromLineupSlotId: currentSlotOf(player),
      toLineupSlotId: SLOT.BENCH,
    });
  }

  // IR players: only submit IR moves for TODAY's period. Future periods reject IR transactions.
  if (scoringPeriodId <= currentScoringPeriodId) {
    for (const player of irPlayers) {
      items.push({
        playerId: player.playerId,
        type: 'LINEUP',
        fromLineupSlotId: currentSlotOf(player),
        toLineupSlotId: SLOT.IR,
      });
    }
  }

  // Filter out NO-OP moves to prevent TRAN_INVALID_SCORINGPERIOD_NOT_CURRENT on future days
  return items.filter(item => item.fromLineupSlotId !== item.toLineupSlotId);
}
