import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnalyticsGate } from '../../src/analytics-gate.js';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool } from '../../src/db/replica.js';
import {
  fixedCostMonetaryMaxRecords, parseFixedCostMonetaryQuery, type FixedCostDeletedRowPolicy,
} from '../../src/fixed-costs/monetary-contract.js';
import { FixedCostMonetaryError, FixedCostMonetaryTruncated, queryFixedCostMonetaryTotals } from '../../src/fixed-costs/monetary-repository.js';
import { fixedCostDifferenceBuckets } from '../../src/fixed-costs/reconciliation-contract.js';

/**
 * Opt-in only. `FIXED_COST_MONETARY_MONTH` names one settled `YYYY-MM-01` period.
 *
 * Output is record counts, bucket counts and structural counters. **No monetary
 * value is printed**: authoritative totals, component totals and differences stay
 * inside the process, because they are raw ERP financial data.
 *
 * The deleted-row policy is supplied here by the internal test caller only. It is
 * absent from every public contract and cannot be chosen by an API consumer.
 */
const requested = process.env.FIXED_COST_MONETARY_MONTH;
const testPolicy: FixedCostDeletedRowPolicy = Object.freeze({
  treatment: 'separate_by_state', approved: true, approvedBy: 'internal-integration-test', reference: 'FC-03',
});

test('opt-in bounded internal truck fixed-cost monetary aggregation', { skip: requested === undefined }, async () => {
  const query = parseFixedCostMonetaryQuery({
    allocationScope: 'truck', representation: 'current', periodMonth: requested, limit: fixedCostMonetaryMaxRecords,
  });
  const config = loadConfig();
  const pool = createReplicaPool(config.replica, config.safety.queryTimeoutMs);
  const gate = new AnalyticsGate(config.safety.analyticsConcurrency, config.safety.analyticsQueueLimit, config.safety.analyticsQueueTimeoutMs);
  try {
    // The unapproved default must fail closed even against the live replica.
    await assert.rejects(
      queryFixedCostMonetaryTotals(pool, gate, {
        allocationScope: 'truck', representation: 'current', periodMonth: query.periodMonth, limit: 10,
      }),
      (error: unknown) => error instanceof Error && error.name === 'FixedCostDeletedPolicyUnapproved',
    );

    for (const representation of ['current', 'locked'] as const) {
      const started = performance.now();
      const input = { allocationScope: 'truck', representation, periodMonth: query.periodMonth, limit: fixedCostMonetaryMaxRecords };
      let outcome: Record<string, unknown>;
      try {
        const result = await queryFixedCostMonetaryTotals(pool, gate, input, testPolicy);
        // Counters only. Monetary fields are deliberately not read into the log.
        outcome = {
          representation,
          durationMs: Math.round(performance.now() - started),
          recordsRead: result.meta.recordsRead,
          recordLimit: result.meta.recordLimit,
          complete: result.meta.complete,
          dateBasis: result.meta.dateBasis,
          missingTaskCount: result.meta.missingTaskCount,
          truckFilterApplied: result.meta.truckFilterApplied,
          reconciliationStatus: result.meta.reconciliationStatus,
          groups: result.groups.map(group => ({
            deletedState: group.deletedState,
            groupReconciliation: group.reconciliationStatus,
            comparisonAvailable: group.componentTotal !== null,
            missingTaskCount: group.missingTaskCount,
            authoritativeRecords: group.authoritativeRecords,
            comparableRecords: group.comparableRecords,
            affectedRecords: group.affectedRecords,
            noDetailRecords: group.noDetailRecords,
            multipleDetailRecords: group.multipleDetailRecords,
            missingTotalRecords: group.missingTotalRecords,
            buckets: group.buckets,
          })),
        };
        for (const group of result.groups) {
          const bucketed = fixedCostDifferenceBuckets.reduce((sum, name) => sum + group.buckets[name], 0);
          assert.equal(bucketed, group.comparableRecords, 'Buckets cover comparable records');
          assert.equal(
            group.comparableRecords + group.noDetailRecords + group.multipleDetailRecords + group.missingTotalRecords,
            group.authoritativeRecords, 'Record classes cover the authoritative population',
          );
          // A group with no comparable record must report null, never a fabricated zero.
          const comparison = ['comparableAuthoritativeTotal', 'componentTotal', 'netDifference', 'grossAbsoluteDifference'] as const;
          for (const field of comparison) {
            if (group.comparableRecords === 0) {
              assert.equal(group[field], null, `${field} is null without comparable records`);
            } else {
              assert.match(group[field]!, /^-?\d+\.\d{1,6}$/, `${field} is canonical decimal text`);
            }
          }
          assert.equal(group.reconciliationStatus, group.comparableRecords === 0 ? 'structurally_non_comparable' : 'unreconciled');
          if (group.authoritativeRecords > group.missingTotalRecords) {
            assert.match(group.authoritativeTotal!, /^-?\d+\.\d{1,6}$/, 'The real authoritative total survives');
          }
          assert.ok(group.missingTaskCount <= group.authoritativeRecords, 'Missing-task count within the population');
        }
      } catch (error) {
        if (!(error instanceof FixedCostMonetaryTruncated)) throw error;
        // The bound is a safety property: a truncated period yields no partial sum.
        outcome = {
          representation,
          durationMs: Math.round(performance.now() - started),
          blocked: 'record_bound_exceeded',
          recordLimit: error.recordLimit,
        };
      }
      console.log('Fixed-cost monetary', JSON.stringify(outcome));
      assert.doesNotMatch(JSON.stringify(outcome), /\d+\.\d/, 'No monetary value is logged');
    }
  } catch (error) {
    if (error instanceof assert.AssertionError) throw new Error(`Fixed-cost monetary assertion failed: ${error.message}`);
    throw new Error(error instanceof FixedCostMonetaryError && error.code === 'QUERY_TIMEOUT'
      ? 'Fixed-cost monetary integration timed out' : 'Fixed-cost monetary integration failed');
  } finally {
    try { await pool.end(); } catch { throw new Error('Fixed-cost monetary pool close failed'); }
  }
});
