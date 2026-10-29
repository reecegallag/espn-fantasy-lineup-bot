/**
 * Minimum-cost rectangular assignment (Hungarian algorithm, O(n^2 m)).
 *
 * Used to fill lineup slots optimally. The old greedy fill walked the slots in a
 * fixed order and handed each one the best remaining player, which can burn a
 * flexible player on an early slot and leave a later slot empty.
 *
 * @param {number[][]} cost  n rows x m cols, n <= m, finite numbers
 * @returns {number[]} for each row, the column assigned to it
 */
export function minCostAssignment(cost) {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0].length;
  if (n > m) throw new Error('minCostAssignment needs rows <= cols');

  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0); // p[j] = row matched to column j (1-indexed)
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity);
    const used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const rowToCol = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    if (p[j]) rowToCol[p[j] - 1] = j - 1;
  }
  return rowToCol;
}
