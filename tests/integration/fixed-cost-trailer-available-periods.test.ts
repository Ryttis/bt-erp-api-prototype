import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { trailerAvailablePeriodCandidateMonths } from '../../src/fixed-costs/pilot-trailer-available-periods.js';

/**
 * Opt-in only. `FIXED_COST_TRAILER_AVAILABLE_PERIODS_TEST` names one or more
 * `<trailerId>:<year>` pairs, comma-separated.
 *
 * Cross-checks the real available-periods route against the real single-trailer
 * summary route for every settled month of the year, with the trailer pilot flag
 * forced on for this process only: a month is listed exactly when the summary for
 * that month returns 200. Output is counts, statuses and durations only. **No
 * amount, trailer ID, month or row is printed.**
 */

const requested = process.env.FIXED_COST_TRAILER_AVAILABLE_PERIODS_TEST;

test('opt-in live trailer available-periods cross-check', { skip: requested === undefined }, async () => {
  const app = buildApp(loadConfig({ ...process.env, ERP_FIXED_COST_TRAILER_PILOT_ENABLED: 'true' }));
  const headers = { authorization: `Bearer ${loadConfig(process.env).auth.serviceToken}` };
  try {
    for (const [index, pair] of requested!.split(',').entries()) {
      const match = /^\s*([1-9][0-9]*):([0-9]{4})\s*$/.exec(pair);
      assert.ok(match, 'Each entry is <trailerId>:<year>');
      const [, trailerId, year] = match;

      const started = performance.now();
      const response = await app.inject({ url: `/expense-analytics/fixed-costs/available-periods?allocationScope=trailer&trailerId=${trailerId}&year=${year}`, headers });
      const availableMs = Math.round(performance.now() - started);
      assert.equal(response.statusCode, 200, `Entry ${index}: available-periods succeeds`);
      const available = response.json().data.availableMonths as string[];

      const summaryStatuses: Record<string, number> = {};
      const summaryEligible: string[] = [];
      for (const month of trailerAvailablePeriodCandidateMonths(Number(year))) {
        const [y, m] = month.split('-').map(Number);
        const dateTo = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        const summary = await app.inject({ url: `/expense-analytics/fixed-costs/summary?allocationScope=trailer&trailerId=${trailerId}&dateFrom=${month}&dateTo=${dateTo}`, headers });
        const key = summary.statusCode === 200 ? '200' : `${summary.statusCode} ${summary.json().error?.code}`;
        summaryStatuses[key] = (summaryStatuses[key] ?? 0) + 1;
        if (summary.statusCode === 200) summaryEligible.push(month.slice(0, 7));
      }
      const matches = JSON.stringify(available) === JSON.stringify(summaryEligible);
      console.log('Trailer available periods', JSON.stringify({ entry: index, availableCount: available.length, availableMs, summaryStatuses, matches }));
      assert.ok(matches, `Entry ${index}: availableMonths equals the months the summary answers`);
    }
  } finally { await app.close(); }
});
