/**
 * Normalizer: raw ESPN API JSON → clean domain objects.
 *
 * Player shape:
 * {
 *   playerId, name, teamId,
 *   proTeamId,          // NBA team id (0 = free agent / none)
 *   injuryStatus,       // 'OUT' for injured (raw ESPN 'O'/'IL' folded to 'OUT'); other raw codes pass through and are treated as healthy; null when absent
 *   lineupSlotId,       // current slot (basketball: 0=PG, 12=BENCH, 13=IR, …)
 *   eligibleSlots,      // int[]
 *   projectedPoints,    // float: blended fantasy points per game (0 if unavailable)
 *   fpAverages,         // { season, last7, last15, last30, projected } fantasy points per game; keys absent when unavailable
 *   injuryDate          // injury onset date (ISO string) or null; ESPN exposes no projected return date
 * }
 *
 * LeagueSettings shape:
 * {
 *   currentScoringPeriodId,
 *   finalScoringPeriodId,
 *   irSlotCount,
 *   rosterSlots,        // { slotId: count }
 * }
 */

import { blendedFpPerGame } from '../core/projection.js';

export function normalizeLeague(raw) {
  const settings = extractSettings(raw);
  const players = extractPlayers(raw);
  return { league: settings, players };
}

function extractSettings(raw) {
  const status = raw.status || {};
  const rosterSettings = raw.settings?.rosterSettings || {};

  const lineupSlotCounts = rosterSettings.lineupSlotCounts || {};
  const irSlotCount = lineupSlotCounts['13'] ?? lineupSlotCounts[13] ?? 0; // basketball IR = slot 13

  return {
    currentScoringPeriodId: status.currentMatchupPeriod
      ? raw.scoringPeriodId ?? status.currentMatchupPeriod
      : raw.scoringPeriodId ?? 1,
    finalScoringPeriodId: status.finalScoringPeriod ?? status.finalMatchupPeriod ?? 154,
    irSlotCount: Number(irSlotCount),
    rosterSlots: lineupSlotCounts,
  };
}

// ESPN stat split ids: 0 = full season, 1 = last 7, 2 = last 15, 3 = last 30.
// statSourceId: 0 = actual stats, 1 = ESPN projections. (From ESPN's payload conventions;
// verify against a live response if values look off.)
const SPLIT_NAMES = { 0: 'season', 1: 'last7', 2: 'last15', 3: 'last30' };

/**
 * Pull per-game fantasy point averages for the current season out of a player's stat entries.
 * ESPN's `appliedAverage` is already computed with the league's scoring settings.
 * Entries may sit on the player or on the pool entry, so both are searched.
 *
 * @returns {{season?: number, last7?: number, last15?: number, last30?: number, projected?: number}}
 */
function extractFpAverages(playerData, poolEntry, seasonId) {
  const entries = [...(playerData.stats ?? []), ...(poolEntry.stats ?? [])];
  const out = {};
  for (const s of entries) {
    if (s == null || s.appliedAverage == null) continue;
    if (seasonId != null && s.seasonId != null && Number(s.seasonId) !== Number(seasonId)) continue;
    const value = Number(s.appliedAverage);
    if (!Number.isFinite(value)) continue;

    if (s.statSourceId === 1) {
      if (s.statSplitTypeId === 0 && out.projected === undefined) out.projected = value;
      continue;
    }
    const name = SPLIT_NAMES[s.statSplitTypeId];
    if (name && out[name] === undefined) out[name] = value;
  }
  return out;
}

function extractPlayers(raw) {
  const seasonId = raw.seasonId ?? null;
  const players = [];

  for (const team of raw.teams || []) {
    const teamId = team.id;
    const roster = team.roster?.entries || [];

    for (const entry of roster) {
      const playerData = entry.playerPoolEntry?.player || {};
      const poolEntry = entry.playerPoolEntry || {};

      const playerId = playerData.id ?? entry.playerId;
      const name = playerData.fullName ?? `Player ${playerId}`;
      const proTeamId = playerData.proTeamId ?? 0;
      const eligibleSlots = playerData.eligibleSlots ?? poolEntry.eligibleSlots ?? [];

      // Injury status: only treat 'OUT' (or its variants 'O', 'IL') as injured per spec
      let injuryStatus = poolEntry.injuryStatus ?? playerData.injuryStatus ?? null;
      if (injuryStatus === 'O' || injuryStatus === 'IL') {
        injuryStatus = 'OUT';
      }

      // Fantasy points per game by split, already scored with the league's settings.
      const fpAverages = extractFpAverages(playerData, poolEntry, seasonId);
      // Legacy single number (blend of the splits); the optimizer reads fpAverages directly.
      const projectedPoints = blendedFpPerGame(fpAverages) ?? 0;

      // Injury onset date from the pool entry. ESPN's roster payload does not
      // expose a projected return date, so this is the only injury-timing signal.
      const injuryDate = poolEntry.injuryDate ?? null;

      players.push({
        playerId,
        name,
        teamId,
        proTeamId,
        injuryStatus,
        lineupSlotId: entry.lineupSlotId,
        eligibleSlots: Array.isArray(eligibleSlots) ? eligibleSlots : [],
        projectedPoints: Number(projectedPoints) || 0,
        fpAverages,
        injuryDate,
      });
    }
  }

  return players;
}

/**
 * Parse per-day ESPN public scoreboard responses into a date → team IDs map.
 *
 * @param {Array<{dateStr: string, raw: object|null}>} dayResults
 *   One entry per fetchNBADayScoreboard call. dateStr is "YYYYMMDD".
 * @returns {Object<string, Set<number>>} YYYYMMDD → Set<ESPN teamId>
 */
export function normalizePublicSchedule(dayResults) {
  const dateToTeams = {};

  for (const { dateStr, raw } of dayResults) {
    if (!raw) continue;

    if (!raw.events || raw.events.length === 0) continue;

    const teams = new Set();
    for (const event of raw.events) {
      for (const comp of event.competitions?.[0]?.competitors ?? []) {
        const id = Number(comp.id ?? comp.team?.id);
        if (id) teams.add(id);
      }
    }
    if (teams.size > 0) {
      dateToTeams[dateStr] = teams;
    }
  }

  return dateToTeams;
}

/** Filter normalized players down to a single fantasy team ("my team"). */
export function getMyPlayers(players, teamId) {
  return players.filter(p => p.teamId === teamId);
}

/**
 * Resolve a team's display name from its raw ESPN team entry, with fallbacks.
 *
 * @param {object|undefined} teamEntry — raw ESPN team object (may be undefined)
 * @param {number} fallbackTeamId — used when no name fields resolve
 * @returns {string}
 */
export function formatTeamName(teamEntry, fallbackTeamId) {
  if (!teamEntry) return `Team ${fallbackTeamId}`;
  return teamEntry.name
    || `${teamEntry.location || ''} ${teamEntry.nickname || ''}`.trim()
    || teamEntry.abbrev
    || `Team ${fallbackTeamId}`;
}
