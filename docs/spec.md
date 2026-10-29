# ESPN Season Lineup Setup — Product Spec

## Overview

A Google Chrome Extension and Node.js Bot Server that performs a **one-time bulk lineup setup** for an entire ESPN Fantasy Basketball season, or runs continuously in the background to handle updates right before tip-off.

The tool is smarter than ESPN's built-in Quick Lineup in one critical way: it **accounts for injured players' expected return dates** and pre-fills them into starting slots from that date forward, rather than ignoring them entirely. It also automatically moves players on and off the Injured Reserve (IR) slots **dynamically on game days** if operating in 24/7 background mode.

---

## Problem with ESPN's Quick Lineup

ESPN's Quick Lineup:
- Skips injured players entirely — won't roster them even if they're coming back soon
- Doesn't look ahead — only handles the current week
- Doesn't account for IR slot strategy when multiple players are injured

This leaves value on the table. A player expected back in 3 days should be pre-slotted as a starter for the rest of the season from day 3 onward.

---

## Core Features

### 1. Lineup Submission (Two Operating Modes)

**Mode A: One-Time Manual Setup (Chrome Extension)**
- On run, the extension reads the user's ESPN roster and the full NBA schedule
- For every remaining game day of the season, it determines the optimal starting lineup
- It bulk-submits all of those lineup decisions to ESPN (via ESPN's private fantasy API)
- User can **re-run at any time** to refresh (e.g., after a trade, pickup, or player return from injury)

**Mode B: 24/7 Automation (Premium/Local Bot Server + Extension Bridge)**
- A background `Node.js` server uses `node-schedule` to analyze the NBA master schedule every day at 12:01 AM.
- Exactly 5 minutes before the earliest game, the bot evaluates the user's roster priorities and adjusts active lineup slots automatically.
- The Chrome Extension works passively as an autonomous bridge — provided the user enters a valid `licenseKey` and grants consent, it captures their session tokens when they log into `fantasy.espn.com` and `POST`s them directly to the companion Bot Server to maintain synchronization.

### 2. Start/Bench Decision Logic (Expected Points)

Each player gets an **expected-points** score for the day (`src/core/projection.js`):

`expected points = P(plays) x blended fantasy points per game`, and 0 if his team has no game.

- **Fantasy points per game** come from ESPN's `appliedAverage`, which is already computed with the league's own scoring settings. They are blended across last 7, last 15, last 30, season, and ESPN's preseason projection, leaning on recent form (weights in `SPLIT_WEIGHTS`).
- **P(plays)** comes from injury status: Probable 0.95, Day-to-Day 0.6, Questionable 0.5, Doubtful 0.15, Out 0. On **future days** only Out-style statuses carry forward; everything else counts as healthy because status is unknowable that far ahead.
- Players with no stats at all get a small positive fallback so healthy players with a game still start.

Starting slots are then filled with the **assignment that maximizes total expected points** (Hungarian algorithm, `src/core/assignment.js`), respecting each player's ESPN slot eligibility so flex slots (G, F, UTIL) and multi-position players are solved jointly. Players with 0 expected points (no game, ruled out) are benched; a slot with no eligible candidate stays empty. Ties prefer leaving a player in his current slot to avoid needless transactions.

> Return dates are NOT used in lineup decisions. Injured return dates get pushed back constantly and can't be trusted.

### 3. IR Slot Strategy

When the user has multiple injured players but limited IR slots:

- **Latest expected return date → IR slot**
  - The player who will be out the longest occupies the IR slot
  - This keeps an active roster spot free for shorter-term injured players
  - Shorter-term injured players sit on the active bench (benched, but pre-slotted as starters once their return date passes)

Example: 3 players injured, 1 IR slot, return dates are Jan 10, Feb 1, Mar 15:
- Mar 15 player → IR
- Feb 1 player → active bench (starts in lineup from Feb 1 onward)
- Jan 10 player → active bench (starts in lineup from Jan 10 onward)

### 4. Re-Run Anytime
- The extension can be re-run at any point in the season
- Re-running overwrites all future lineup submissions with freshly optimized decisions
- Use case: player returns from injury and is now healthy, trade happens, new pickup added

---

## Lineup Slot Filling Rules

Standard ESPN NBA roster slots: `PG, SG, SF, PF, C, G, F, UTIL, Bench×N, IR×N`

Filling logic per game day:
1. Score every player by expected points (see above)
2. Assign players to the active slots (PG, SG, SF, PF, C, G, F, UTIL) to maximize total expected points
3. Fill bench slots with remaining rostered players

---

## Data Sources (ESPN Unofficial API)

The extension pulls all data from ESPN's private fantasy API (same endpoints ESPN's own app uses):

| Data | ESPN Endpoint |
|------|--------------|
| User's roster | `fantasy.espn.com` league roster endpoint |
| Player injury status | ESPN player data (injury flag + estimated return) |
| Player projections | ESPN projected stats / season averages |
| NBA game schedule | ESPN schedule API |
| Lineup submission | ESPN fantasy lineup set endpoint |

The extension runs authenticated as the logged-in user (uses existing ESPN session cookies), so no separate login is needed.

---

## League Configuration

- **Scoring type**: Points league (each stat worth a set point value)
- Optimization goal: maximize total projected points in active slots across all game days

---

## User Flow

1. User opens their ESPN Fantasy Basketball league in Chrome
2. User clicks the extension icon
3. Extension shows a preview:
   - Current injured players and proposed IR assignment
   - Summary of how many game days will be submitted
4. User clicks **"Set Season Lineup"**
5. Extension bulk-submits lineup for every remaining game day
6. Confirmation shown: "X lineup days submitted"

---

## Edge Cases & Constraints

| Scenario | Behavior |
|----------|----------|
| Player return date unknown | Treat as indefinitely injured — skip for all future dates |
| Multiple players eligible for same slot | Higher projected points wins |
| Only injured players at a position | Leave the slot empty / bench — never start an injured player |
| All IR slots full | Put longest-out player in the furthest IR slot; if no IR slot available, injured player stays on bench (benched for all dates until return) |
| Re-run mid-season | Overwrites only future dates; past submissions untouched |
| Player on waivers / dropped | Not on roster, not considered |

---

## Out of Scope (v1)

- Opponent matchup/defense adjustments
- Trade recommendations
- Waiver wire suggestions
- Notification/alerts when a player returns
- Support for leagues other than points format
