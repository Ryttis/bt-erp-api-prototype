import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { queryReadOnly, safeDriverDiagnostics } from '../../src/db/replica.js';
import { parseFixedCostReconciliationMonth } from '../../src/fixed-costs/reconciliation-contract.js';
import { trailerFleetGroupsStatement, trailerFleetTotalsStatement } from '../../src/fixed-costs/trailer-fleet-repository.js';

/**
 * Opt-in only. `FIXED_COST_TRAILER_FLEET_TEST_MONTHS` names one or more settled
 * `YYYY-MM-01` months, comma-separated.
 *
 * Exercises the real fleet trailer routes against the configured replica with the
 * trailer pilot flag forced on for this process only, and reconciles them against
 * independent direct aggregate reads of the same population and against the
 * single-trailer endpoint. Output is status, counters, durations, match flags and
 * EXPLAIN access metadata. **No monetary amount, task ID, trailer ID or row is
 * printed**; assertions compare amounts without putting them in a message.
 */

const requested = process.env.FIXED_COST_TRAILER_FLEET_TEST_MONTHS;
const planNumber = (value: unknown) => value === null || value === undefined ? null : Number(value);

function safeFailure(stage: string, error: unknown): Error {
  if (error instanceof assert.AssertionError) return new Error(`Trailer fleet pilot ${stage} assertion failed: ${error.message}`);
  const source = error as Record<string, unknown> | null;
  if (source && typeof source === 'object' && ('sqlState' in source || 'errno' in source || 'cause' in source)) {
    return new Error(`Trailer fleet pilot ${stage} failed: ${JSON.stringify(safeDriverDiagnostics(error))}`);
  }
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : '';
  return new Error(`Trailer fleet pilot ${stage} failed: ${name}: ${message}`);
}

/** Exact integer cents from two-scale decimal text. Test-side verification only. */
function cents(value: string): bigint {
  const match = /^(-?)(0|[1-9][0-9]*)\.([0-9]{2})$/.exec(value);
  assert.ok(match, 'Amount is canonical two-scale decimal text');
  const magnitude = BigInt(match[2]) * 100n + BigInt(match[3]);
  return match[1] === '-' ? -magnitude : magnitude;
}

test('opt-in live fleet trailer fixed-cost pilot', { skip: requested === undefined }, async () => {
  const config = loadConfig({ ...process.env, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'true' });
  const app = buildApp(config);
  const disabledApp = buildApp(loadConfig({ ...process.env, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'false' }));
  const headers = { authorization: `Bearer ${config.auth.serviceToken}` };
  let stage = 'setup';
  try {
    for (const month of requested!.split(',')) {
      const period = parseFixedCostReconciliationMonth(month.trim());
      const [year, monthNumber] = period.month.split('-').map(Number);
      const dateTo = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
      const query = `allocationScope=trailer&dateFrom=${period.month}&dateTo=${dateTo}`;
      const summaryUrl = `/expense-analytics/fixed-costs/summary?${query}`;
      const breakdownUrl = `/expense-analytics/fixed-costs/breakdown?${query}`;
      const bounds = [period.month, period.monthEnd];

      stage = `${period.month} authentication and flag`;
      assert.equal((await app.inject(summaryUrl)).statusCode, 401, 'Authentication still required');
      const disabled = await disabledApp.inject({ url: summaryUrl, headers });
      assert.equal(disabled.statusCode, 422, 'Flag off refuses the fleet request');
      assert.equal(disabled.json().error.code, 'SEMANTICS_UNVERIFIED');

      stage = `${period.month} summary`;
      const summaryStarted = performance.now();
      const summaryResponse = await app.inject({ url: summaryUrl, headers });
      const summaryMs = Math.round(performance.now() - summaryStarted);
      if (summaryResponse.statusCode !== 200) {
        console.log('Trailer fleet pilot', JSON.stringify({ month: period.month, status: summaryResponse.statusCode, code: summaryResponse.json().error?.code, summaryMs }));
      }
      assert.equal(summaryResponse.statusCode, 200, 'Settled month succeeds');
      const { data, meta } = summaryResponse.json();
      assert.ok(meta.complete === true && meta.pilot === true && meta.attribution.invariantVerified === true);
      assert.equal(data.lockedTaskCount, data.totalTaskCount, 'Fully locked included population');
      assert.equal(data.attributedTaskCount + data.unattributedTaskCount, data.totalTaskCount, 'Every task is attributed or unattributed');
      const invariant = cents(data.attributedAmount) + cents(data.unattributedAmount) === cents(data.amount);
      assert.ok(invariant, 'attributed + unattributed = total');
      const categories = Object.values(data.unattributedCategories) as { amount: string; taskCount: number; nonZeroTaskCount: number }[];
      assert.ok(categories.reduce((total, entry) => total + cents(entry.amount), 0n) === cents(data.unattributedAmount), 'Categories add up to the unattributed amount');
      assert.equal(categories.reduce((total, entry) => total + entry.taskCount, 0), data.unattributedTaskCount);

      // Independent direct reads of the same deleted = 0 population, written differently
      // from the repository statement (inner joins and explicit predicates, no classification).
      stage = `${period.month} direct source reads`;
      const [source] = await queryReadOnly<Record<string, unknown>[]>(app.replica, `SELECT COUNT(*) AS records,
          CAST(SUM(a.locked_kastaiPriekabos) AS CHAR) AS total
        FROM kastai_fiksuoti_ataskaita a
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0`, bounds);
      const [attributed] = await queryReadOnly<Record<string, unknown>[]>(app.replica, `SELECT COUNT(*) AS records,
          COUNT(DISTINCT t.uzdavinio_priekaba) AS trailers, CAST(COALESCE(SUM(a.locked_kastaiPriekabos), 0.00) AS CHAR) AS total
        FROM kastai_fiksuoti_ataskaita a
        JOIN uzdaviniai t ON t.id = a.uzdavinys
        JOIN priekabos p ON p.id = t.uzdavinio_priekaba
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0 AND t.uzdavinio_priekaba > 0`, bounds);
      const [unattributed] = await queryReadOnly<Record<string, unknown>[]>(app.replica, `SELECT COUNT(*) AS records,
          SUM(CASE WHEN a.locked_kastaiPriekabos <> 0 THEN 1 ELSE 0 END) AS nonZero,
          SUM(CASE WHEN t.id IS NULL THEN 1 ELSE 0 END) AS missingTask,
          SUM(CASE WHEN t.id IS NOT NULL AND NOT (t.uzdavinio_priekaba > 0) THEN 1 ELSE 0 END) AS missingAssignment,
          CAST(COALESCE(SUM(a.locked_kastaiPriekabos), 0.00) AS CHAR) AS total
        FROM kastai_fiksuoti_ataskaita a
        LEFT JOIN uzdaviniai t ON t.id = a.uzdavinys
        WHERE a.kastai_data >= ? AND a.kastai_data < ? AND a.deleted = 0
          AND NOT EXISTS (SELECT 1 FROM priekabos p WHERE p.id = t.uzdavinio_priekaba AND t.uzdavinio_priekaba > 0)`, bounds);
      const matches = {
        sourceTotal: data.amount === source.total,
        sourceTaskCount: data.totalTaskCount === Number(source.records),
        attributedAmount: data.attributedAmount === attributed.total,
        attributedTaskCount: data.attributedTaskCount === Number(attributed.records),
        attributedTrailerCount: data.attributedTrailerCount === Number(attributed.trailers),
        unattributedAmount: data.unattributedAmount === unattributed.total,
        unattributedTaskCount: data.unattributedTaskCount === Number(unattributed.records),
        unattributedNonZeroTaskCount: data.unattributedNonZeroTaskCount === Number(unattributed.nonZero ?? 0),
        missingTaskCount: data.unattributedCategories.missingTask.taskCount === Number(unattributed.missingTask ?? 0),
        missingAssignmentCount: data.unattributedCategories.missingAssignment.taskCount === Number(unattributed.missingAssignment ?? 0),
      };
      for (const [name, matched] of Object.entries(matches)) assert.ok(matched, `Endpoint ${name} matches the direct source read`);

      stage = `${period.month} breakdown`;
      const breakdownStarted = performance.now();
      const breakdownResponse = await app.inject({ url: breakdownUrl, headers });
      const breakdownMs = Math.round(performance.now() - breakdownStarted);
      assert.equal(breakdownResponse.statusCode, 200, 'Fleet breakdown succeeds');
      const breakdown = breakdownResponse.json().data;
      const groups = breakdown.groups as { trailerId: number; lockedAmount: string; taskCount: number }[];
      for (const field of ['amount', 'attributedAmount', 'unattributedAmount', 'totalTaskCount', 'attributedTrailerCount', 'unattributedTaskCount']) {
        assert.ok(breakdown[field] === data[field], `Breakdown ${field} equals the summary`);
      }
      assert.equal(groups.length, data.attributedTrailerCount, 'One group per attributed trailer');
      const groupSumMatches = groups.reduce((total, group) => total + cents(group.lockedAmount), 0n) === cents(data.attributedAmount);
      assert.ok(groupSumMatches, 'Trailer groups add up to the attributed amount');
      assert.equal(groups.reduce((total, group) => total + group.taskCount, 0), data.attributedTaskCount);
      const ordered = groups.every((group, index) => {
        if (index === 0) return true;
        const previous = groups[index - 1];
        const [a, b] = [cents(previous.lockedAmount), cents(group.lockedAmount)];
        return a > b || (a === b && previous.trailerId < group.trailerId);
      });
      assert.ok(ordered, 'Groups are ordered by amount descending, then trailerId ascending');
      assert.ok(groups.every(group => Number.isSafeInteger(group.trailerId) && group.trailerId > 0), 'Every group has a positive trailer id');
      assert.ok((breakdown.unattributed === null) === (data.unattributedTaskCount === 0), 'The unattributed bucket is present exactly when needed');

      // Several individual trailers against the single-trailer endpoint: first, last, and spread in between.
      stage = `${period.month} single-trailer comparison`;
      const picks = [...new Set([0, 1, Math.floor(groups.length / 4), Math.floor(groups.length / 2), Math.floor(groups.length * 3 / 4), groups.length - 2, groups.length - 1]
        .filter(index => index >= 0 && index < groups.length))];
      let singleMatches = 0;
      for (const index of picks) {
        const group = groups[index];
        const single = await app.inject({ url: `${summaryUrl}&trailerId=${group.trailerId}`, headers });
        assert.equal(single.statusCode, 200, 'Single-trailer summary succeeds for a fleet group');
        assert.ok(single.json().data.amount === group.lockedAmount, 'Group amount equals the single-trailer summary');
        assert.ok(single.json().data.totalTaskCount === group.taskCount, 'Group task count equals the single-trailer summary');
        singleMatches++;
      }

      stage = `${period.month} EXPLAIN`;
      const explain = async (statement: string) => (await queryReadOnly<Record<string, unknown>[]>(app.replica, `EXPLAIN ${statement}`, bounds))
        .map(row => ({ id: planNumber(row.id), table: row.table, type: row.type, key: row.key, rows: planNumber(row.rows), extra: row.Extra }));
      console.log('Trailer fleet pilot', JSON.stringify({
        month: period.month, summaryMs, breakdownMs,
        totalTaskCount: data.totalTaskCount, lockedTaskCount: data.lockedTaskCount,
        attributedTaskCount: data.attributedTaskCount, attributedTrailerCount: data.attributedTrailerCount,
        unattributedTaskCount: data.unattributedTaskCount, unattributedNonZeroTaskCount: data.unattributedNonZeroTaskCount,
        unattributedAmountIsZero: cents(data.unattributedAmount) === 0n,
        categories: Object.fromEntries(Object.entries(data.unattributedCategories as Record<string, { taskCount: number; nonZeroTaskCount: number }>)
          .map(([name, entry]) => [name, { taskCount: entry.taskCount, nonZeroTaskCount: entry.nonZeroTaskCount }])),
        invariantHolds: invariant, groupSumMatchesAttributed: groupSumMatches, ordered, matches,
        singleTrailerChecks: picks.length, singleTrailerMatches: singleMatches,
      }));
      console.log('Trailer fleet pilot EXPLAIN totals', JSON.stringify(await explain(trailerFleetTotalsStatement)));
      console.log('Trailer fleet pilot EXPLAIN groups', JSON.stringify(await explain(trailerFleetGroupsStatement)));
    }
  } catch (error) {
    throw safeFailure(stage, error);
  } finally {
    try { await Promise.all([app.close(), disabledApp.close()]); } catch { throw new Error('Trailer fleet pilot app close failed'); }
  }
});
