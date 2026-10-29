import test from 'node:test';
import assert from 'node:assert/strict';

import { optimizeLineup } from '../src/core/optimizer.js';
import { blendedFpPerGame, expectedPoints, playProbability } from '../src/core/projection.js';
import { minCostAssignment } from '../src/core/assignment.js';
import { normalizeLeague } from '../src/api/normalizer.js';
import { SLOT, buildActiveSlots } from '../src/utils/slot-utils.js';

const BENCH = SLOT.BENCH;
const IR = SLOT.IR;

// Slot eligibility helpers (ESPN lists eligible slots per player).
const E = {
  PG: [0, 5, 11],
  SG: [1, 5, 11],
  SF: [2, 6, 11],
  PF: [3, 6, 11],
  C: [4, 11],
  PGSG: [0, 1, 5, 11],
  SFPF: [2, 3, 6, 11],
};

let nextId = 1;
function player(name, eligibleSlots, fp, extra = {}) {
  return {
    playerId: nextId++,
    name,
    proTeamId: 1,
    injuryStatus: null,
    lineupSlotId: BENCH,
    eligibleSlots,
    fpAverages: { season: fp },
    ...extra,
  };
}

const TEAMS = new Set([1]);
const FULL_SLOTS = buildActiveSlots({ 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 11: 1 });

function run(players, { period = 10, current = 10, teams = TEAMS, slots = FULL_SLOTS, ir = [], currentSlots } = {}) {
  return optimizeLineup(players, ir, teams, period, current, currentSlots ?? new Map(), slots);
}

const startersOf = items => items.filter(i => i.toLineupSlotId !== BENCH && i.toLineupSlotId !== IR);
const slotOf = (items, p) => items.find(i => i.playerId === p.playerId)?.toLineupSlotId;

test('assignment solves a case greedy slot-by-slot filling gets wrong', () => {
  // Slots PG then G. X can fill either; Y can only fill PG. Greedy gives X the PG slot and strands Y.
  const X = player('X', E.PG, 20);
  const Y = player('Y', [0, 11], 15);
  const items = run([X, Y], { slots: [SLOT.PG, SLOT.G] });
  assert.equal(slotOf(items, Y), SLOT.PG);
  assert.equal(slotOf(items, X), SLOT.G);
});

test('minCostAssignment returns the cheapest full assignment', () => {
  const cost = [
    [4, 1, 3],
    [2, 0, 5],
    [3, 2, 2],
  ];
  const result = minCostAssignment(cost);
  const total = result.reduce((s, col, row) => s + cost[row][col], 0);
  assert.equal(total, 5); // 1 + 2 + 2
  assert.equal(new Set(result).size, 3);
});

test('players with no game or ruled OUT never start', () => {
  const rest = player('Rest', E.PG, 40, { proTeamId: 2 });
  const out = player('Out', E.SG, 40, { injuryStatus: 'OUT' });
  const ok = player('Ok', E.PGSG, 10);
  const items = run([rest, out, ok]);
  assert.notEqual(slotOf(items, ok), undefined);
  assert.ok(startersOf(items).every(i => i.playerId === ok.playerId));
});

test('a questionable star can lose his slot to a healthy near-equal today', () => {
  const star = player('Star', E.PG, 36, { injuryStatus: 'QUESTIONABLE' }); // 36 x 0.5 = 18
  const solid = player('Solid', E.PG, 25); // healthy
  const items = run([star, solid], { slots: [SLOT.PG] });
  assert.equal(slotOf(items, solid), SLOT.PG);
  assert.equal(slotOf(items, star), undefined); // already benched: no move needed
});

test('questionable status is ignored on future days, OUT is not', () => {
  assert.equal(playProbability('QUESTIONABLE', true), 0.5);
  assert.equal(playProbability('QUESTIONABLE', false), 1);
  assert.equal(playProbability('OUT', false), 0);
  const star = player('Star', E.PG, 36, { injuryStatus: 'QUESTIONABLE' });
  const solid = player('Solid', E.PG, 25);
  const items = run([star, solid], { period: 12, current: 10, slots: [SLOT.PG] });
  assert.equal(slotOf(items, star), SLOT.PG);
});

test('players with no stats still start instead of everyone being benched', () => {
  const a = player('A', E.PG, 0, { fpAverages: {} });
  const b = player('B', E.SG, 0, { fpAverages: {} });
  const items = run([a, b]);
  assert.equal(slotOf(items, a), SLOT.PG);
  assert.equal(slotOf(items, b), SLOT.SG);
});

test('leaves a slot empty when nobody is eligible', () => {
  const only = player('Only', E.PG, 20);
  const items = run([only], { slots: [SLOT.C] });
  assert.equal(items.length, 0);
});

test('prefers keeping a player where he is when values tie', () => {
  const a = player('A', E.PGSG, 20, { lineupSlotId: SLOT.SG });
  const b = player('B', E.PGSG, 20, { lineupSlotId: SLOT.PG });
  const items = run([a, b], { slots: [SLOT.PG, SLOT.SG] });
  assert.equal(items.length, 0); // already optimal, no churn
});

test('IR players are only moved on the current day', () => {
  const inj = player('Inj', E.PG, 30, { injuryStatus: 'OUT', lineupSlotId: BENCH });
  const today = run([], { ir: [inj] });
  assert.equal(slotOf(today, inj), IR);
  const future = run([], { period: 12, current: 10, ir: [inj] });
  assert.equal(slotOf(future, inj), undefined);
});

test('blend leans on recent form but keeps season and projection terms', () => {
  const hot = blendedFpPerGame({ last7: 40, last15: 30, last30: 28, season: 25, projected: 24 });
  const cold = blendedFpPerGame({ last7: 20, last15: 22, last30: 24, season: 25, projected: 30 });
  assert.ok(hot > cold);
  assert.equal(blendedFpPerGame({}), null);
  assert.equal(blendedFpPerGame({ season: 18 }), 18);
});

test('expectedPoints is zero without a game', () => {
  const p = player('P', E.PG, 30);
  assert.equal(expectedPoints(p, { playsToday: false, isToday: true }), 0);
  assert.equal(expectedPoints(p, { playsToday: true, isToday: true }), 30);
});

test('normalizer reads per-split fantasy averages for the current season only', () => {
  const stat = (statSourceId, statSplitTypeId, seasonId, appliedAverage) => ({
    statSourceId, statSplitTypeId, seasonId, appliedAverage,
  });
  const raw = {
    seasonId: 2027,
    scoringPeriodId: 10,
    settings: { rosterSettings: { lineupSlotCounts: { 0: 1, 13: 1 } } },
    teams: [{
      id: 1,
      roster: {
        entries: [{
          playerId: 99,
          lineupSlotId: BENCH,
          playerPoolEntry: {
            injuryStatus: 'ACTIVE',
            player: {
              id: 99,
              fullName: 'Test Player',
              proTeamId: 3,
              eligibleSlots: [0, 11],
              stats: [
                stat(0, 0, 2027, 30),
                stat(0, 1, 2027, 40),
                stat(0, 2, 2027, 35),
                stat(0, 3, 2027, 32),
                stat(1, 0, 2027, 28),
                stat(0, 0, 2026, 5), // last year: must be ignored
              ],
            },
          },
        }],
      },
    }],
  };
  const { players } = normalizeLeague(raw);
  assert.deepEqual(players[0].fpAverages, { season: 30, last7: 40, last15: 35, last30: 32, projected: 28 });
});
