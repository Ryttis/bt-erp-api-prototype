import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool, type ReplicaPool } from '../../src/db/replica.js';
import { vehicleFields, type Vehicle } from '../../src/vehicles/repository.js';

test('live extended contract: discovered mappings, ranges, projection and cross-view reconciliation', async () => {
  const pool = createReplicaPool(loadConfig().replica);
  const recorded: { sql: string; values: unknown[] }[] = [];
  const wrapper = { query: async (sql: string, values: unknown[]) => { recorded.push({ sql, values }); return pool.query(sql, values); }, end: () => pool.end() } as ReplicaPool;
  const app = buildApp(loadConfig(), () => wrapper, { authenticate: false });
  const plates = 'plate_numbers=HOO756,LGK058,MUJ352,NHJ910,NJI449,NIR935';
  async function get(query: string, label: string) {
    const started = performance.now();
    const response = await app.inject(`/vehicles?${query}`);
    assert.equal(response.statusCode, 200, label);
    console.log(`${label}: ${(performance.now() - started).toFixed(1)} ms`);
    return response.json();
  }
  try {
    // Read fresh odometer evidence: operational mileage is not a permanent fixture.
    const source: { plate: string; mileage: number | null }[] = await pool.query(`SELECT m.masinos_nr AS plate, s.last_odometer AS mileage
      FROM infot_2.masinos m LEFT JOIN infot_2.masinos_latest_status s ON s.masinos_id=m.id AND s.ar_priekaba=0
      WHERE m.masinos_nr IN (?,?,?,?,?,?)`, ['HOO756','LGK058','MUJ352','NHJ910','NJI449','NIR935']);
    const all: Vehicle[] = (await get(plates, 'Extended six-plate rows')).data;
    for (const row of all) assert.equal(row.mileage, source.find((entry) => entry.plate === row.plate_number)?.mileage);
    console.log('Fresh odometer evidence', JSON.stringify(source));
    const hoo = all.find((row) => row.plate_number === 'HOO756')!;
    const projection = await get(`${plates}&fields=plate_number,mileage,rent_price,plate_number`, 'Exact projection');
    for (const row of projection.data) assert.deepEqual(Object.keys(row), ['plate_number','mileage','rent_price']);
    const mileage = await get(`${plates}&mileage_from=300000&mileage_to=600000&fields=plate_number,mileage`, 'Mileage range');
    assert.deepEqual(mileage.data.map((row: Vehicle) => row.plate_number).sort(), source.filter((row) => row.mileage !== null && row.mileage >= 300000 && row.mileage <= 600000).map((row) => row.plate).sort());
    assert.ok(mileage.meta.total < 6);
    for (const key of ['consumer_id','lessor_id','bank_id','consumer_name','lessor_name','bank_name','department','group'] as const) {
      const filter = new URLSearchParams({ [key]: String(hoo[key]) });
      const filtered = await get(`${plates}&${filter}&fields=plate_number`, `Verified ${key} filter`);
      assert.deepEqual(filtered.data.map((row: Vehicle) => row.plate_number).sort(), all.filter((row) => row[key] === hoo[key]).map((row) => row.plate_number).sort());
    }
    const common = `${plates}&mileage_from=0`;
    const rows = await get(`${common}&fields=plate_number`, 'Filtered rows count');
    const summary = await get(`view=summary&metric=count&${common}`, 'Filtered summary count');
    const grouped = await get(`view=grouped&group_by=active&metric=count&${common}`, 'Filtered grouped counts');
    const distinct = await get(`view=distinct&field=make&${common}`, 'Filtered distinct counts');
    assert.equal(rows.meta.total, summary.data.count);
    for (const result of [grouped, distinct]) assert.equal(result.data.reduce((sum: number, row: {count:number}) => sum+row.count, 0), summary.data.count);
    assert.ok(summary.data.count >= 0 && summary.data.count <= all.length);
    const analytics = await get(`view=summary&metric=min:mileage&metric=max:mileage&metric=avg:mileage&${plates}`, 'Mileage aggregates');
    const odometers = source.flatMap((row) => row.mileage === null ? [] : [row.mileage]);
    assert.equal(analytics.data.min_mileage, Math.min(...odometers));
    assert.equal(analytics.data.max_mileage, Math.max(...odometers));
    assert.ok(Math.abs(analytics.data.avg_mileage - odometers.reduce((a,b)=>a+b,0)/odometers.length) < 0.0001);
    for (const direction of ['asc','desc']) {
      const sorted: Vehicle[] = (await get(`${plates}&fields=plate_number,mileage&sort_by=mileage&sort_direction=${direction}`, 'Mileage null-last sorting')).data;
      const nonnull = sorted.filter((row) => row.mileage !== null);
      assert.ok(sorted.slice(nonnull.length).every((row) => row.mileage === null));
      for (let i=1;i<nonnull.length;i++) assert.ok(direction === 'asc' ? nonnull[i-1].mileage! <= nonnull[i].mileage! : nonnull[i-1].mileage! >= nonnull[i].mileage!);
    }
    // Exercise the actual SQL date expression against read-only literal inputs.
    for (const [year, month, day, expected] of [['2024','2','29','2024-02-29'],['2023','2','29',null],['2025','00','01',null],['2025','01','00',null],['2025','04','31',null],['2025','001','01',null]] as const) {
      const result = await pool.query(`SELECT ${vehicleFields.manufactured_at.sql} AS normalized FROM (SELECT ? AS pag_metai, ? AS pag_menuo, ? AS pag_diena) m`, [year,month,day]);
      assert.equal(result[0].normalized, expected);
    }
    // Full-fleet query with relation/mileage filters and lookup-name sorting.
    await get('mileage_from=0&rent_price_from=0&sort_by=consumer_name&fields=plate_number,mileage,consumer_name&per_page=50', 'Representative fleet query');
    const representative = recorded.at(-1)!;
    const plan = await pool.query(`EXPLAIN ${representative.sql}`, representative.values);
    console.log('Representative EXPLAIN', JSON.stringify(plan.map((row: Record<string, unknown>) => ({ table:row.table, type:row.type, key:row.key, rows:row.rows, extra:row.Extra })), (_k,v)=>typeof v==='bigint'?Number(v):v));
    console.log('Slice 6 live evidence and cross-view reconciliation passed.');
  } finally { await app.close(); }
});
