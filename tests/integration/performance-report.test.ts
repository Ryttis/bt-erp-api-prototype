import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool } from '../../src/db/replica.js';

test('live performance report: representative vehicle operations remain read-only', async () => {
  const config = loadConfig();
  const app = buildApp(config, undefined, { authenticate: false });
  const pool = createReplicaPool(config.replica, config.safety.queryTimeoutMs);
  const timings: Record<string, number> = {};
  try {
    for (const [name, url] of Object.entries({
      rows: '/vehicles?per_page=50',
      projected_rows: '/vehicles?fields=plate_number,mileage,rent_price&per_page=50',
      summary_count: '/vehicles?view=summary&metric=count',
      summary_sum: '/vehicles?view=summary&metric=sum:rent_price',
      distinct_make: '/vehicles?view=distinct&field=make',
      grouped_make: '/vehicles?view=grouped&group_by=make&metric=count',
      mileage_filtered: '/vehicles?mileage_from=0&fields=plate_number,mileage&per_page=50',
      name_sorted: '/vehicles?sort_by=consumer_name&fields=plate_number,consumer_name&per_page=50',
    })) {
      const started = performance.now();
      const response = await app.inject(url);
      timings[name] = Number((performance.now() - started).toFixed(2));
      assert.equal(response.statusCode, 200, name);
    }
    const plans = await Promise.all([
      pool.query(`EXPLAIN SELECT m.id FROM infot_2.masinos m
        LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1)
        LEFT JOIN infot_2.masinu_priekabu_lizinguotojas l ON l.id=(SELECT ll.id FROM infot_2.masinu_priekabu_lizinguotojas ll WHERE ll.masinos_id=m.id ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1) ORDER BY r.kaina IS NULL ASC, r.kaina DESC, m.id ASC LIMIT 50`),
      pool.query(`EXPLAIN SELECT m.id FROM infot_2.masinos m LEFT JOIN infot_2.masinos_latest_status s ON s.masinos_id=m.id AND s.ar_priekaba=0 WHERE s.last_odometer >= 0 LIMIT 50`),
      pool.query(`EXPLAIN SELECT COUNT(*) FROM infot_2.masinos m LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1)`),
      pool.query(`EXPLAIN SELECT CAST(CONVERT(m.marke_2 USING utf8mb4) AS BINARY), COUNT(*) FROM infot_2.masinos m GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 101`),
      pool.query(`EXPLAIN SELECT m.id FROM infot_2.masinos m LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1) LEFT JOIN infot_2.klientai c ON c.id=NULLIF(r.naudotojas,0) WHERE LOWER(c.firmos_pavadinimas) LIKE LOWER(?) ESCAPE '!'`, ['%sample%']),
    ]);
    const compact = plans.map((plan) => plan.map((row: Record<string, unknown>) => ({ table: row.table, type: row.type, key: row.key, rows: row.rows, extra: row.Extra })));
    console.log('Vehicle performance timing ms', JSON.stringify(timings));
    console.log('Vehicle EXPLAIN summary', JSON.stringify(compact, (_key, value) => typeof value === 'bigint' ? Number(value) : value));
  } finally {
    await app.close();
    await pool.end();
  }
});
