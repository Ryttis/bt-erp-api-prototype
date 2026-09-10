import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Vehicle, VehicleCategoryField } from '../../src/vehicles/repository.js';

test('live categories match canonical rows and complete filtered counts', async () => {
  const app = buildApp(loadConfig(), undefined, { authenticate: false });
  const plates = 'plate_numbers=HOO756,LGK058,MUJ352,NHJ910,NJI449,NIR935';
  type Category = string | number | boolean | null;
  type CategoryRow = { value?: Category; group?: Category; count: number; sum_rent_price?: number | null };
  async function get(query: string) {
    const start = performance.now();
    const response = await app.inject(`/vehicles?${query}`);
    assert.equal(response.statusCode, 200, 'Live categorical request succeeds');
    console.log(`Categorical verification ${query.split('&').slice(0, 2).join('&')}: ${(performance.now() - start).toFixed(1)} ms`);
    return response.json();
  }
  function compare(a: { value: Category; count: number }, b: { value: Category; count: number }) {
    if (a.count !== b.count) return b.count - a.count;
    if (a.value === null) return b.value === null ? 0 : 1;
    if (b.value === null) return -1;
    return typeof a.value === 'string' && typeof b.value === 'string'
      ? Buffer.compare(Buffer.from(a.value), Buffer.from(b.value)) : Number(a.value) - Number(b.value);
  }
  try {
    const selected = await app.replica.query<{ count: number; rent_sum: number | null }[]>(`SELECT COUNT(*) AS count, ROUND(SUM(r.kaina), 2) AS rent_sum FROM infot_2.masinos m LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1) WHERE m.masinos_nr IN (?,?,?,?,?,?)`, ['HOO756', 'LGK058', 'MUJ352', 'NHJ910', 'NJI449', 'NIR935']);
    const selectedCount = Number(selected[0].count);
    const selectedRentSum = selected[0].rent_sum === null ? null : Number(selected[0].rent_sum);
    const rows: Vehicle[] = (await get(plates)).data;
    assert.equal(rows.length, selectedCount);
    for (const field of ['make', 'model', 'department', 'group', 'market', 'active', 'consumer_id', 'lessor_id', 'bank_id'] as VehicleCategoryField[]) {
      const counts = new Map<Category, number>();
      for (const row of rows) counts.set(row[field], (counts.get(row[field]) ?? 0) + 1);
      const expected = [...counts].map(([value, count]) => ({ value, count })).sort(compare);
      const distinct = await get(`view=distinct&field=${field}&${plates}`);
      assert.deepEqual(distinct.meta, { view: 'distinct', field, complete: true });
      assert.deepEqual(distinct.data, expected);
      const grouped = await get(`view=grouped&group_by=${field}&metric=count&${plates}`);
      assert.deepEqual(grouped.meta, { view: 'grouped', group_by: field, complete: true });
      assert.deepEqual(grouped.data, expected.map(({ value, count }) => ({ group: value, count })));
      assert.equal(grouped.data.reduce((sum: number, row: CategoryRow) => sum + row.count, 0), selectedCount);
    }
    const finance = await get(`view=grouped&group_by=make&metric=count&metric=sum:rent_price&${plates}`);
    assert.equal(finance.data.reduce((sum: number, row: CategoryRow) => sum + (row.sum_rent_price ?? 0), 0), selectedRentSum ?? 0);
    assert.equal(finance.data.reduce((sum: number, row: CategoryRow) => sum + row.count, 0), selectedCount);
    const zero = await get('view=grouped&group_by=active&metric=sum:rent_price&metric=avg:rent_price&plate_numbers=NIR935');
    const zeroExpected = await app.replica.query<{ count: number; sum_rent_price: number | null; avg_rent_price: number | null }[]>(`SELECT COUNT(*) AS count, ROUND(SUM(r.kaina), 2) AS sum_rent_price, ROUND(AVG(r.kaina), 2) AS avg_rent_price FROM infot_2.masinos m LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1) WHERE m.masinos_nr=?`, ['NIR935']);
    assert.equal(zero.data.length, Number(zeroExpected[0].count));
    if (Number(zeroExpected[0].count) > 0) {
      assert.equal(zero.data[0].sum_rent_price, zeroExpected[0].sum_rent_price === null ? null : Number(zeroExpected[0].sum_rent_price));
      assert.equal(zero.data[0].avg_rent_price, zeroExpected[0].avg_rent_price === null ? null : Number(zeroExpected[0].avg_rent_price));
      assert.equal(Object.hasOwn(zero.data[0], 'count'), false);
    }
    const filtered = await get(`view=distinct&field=make&plate_number=hoo&${plates}`);
    const filteredExpected = await app.replica.query<{ count: number }[]>(`SELECT COUNT(*) AS count FROM infot_2.masinos m WHERE m.masinos_nr IN (?,?,?,?,?,?) AND LOWER(m.masinos_nr) LIKE LOWER(?) ESCAPE '!'`, ['HOO756', 'LGK058', 'MUJ352', 'NHJ910', 'NJI449', 'NIR935', '%hoo%']);
    assert.equal(filtered.data.reduce((sum: number, row: CategoryRow) => sum + row.count, 0), Number(filteredExpected[0].count));
    const department = rows.find((row) => row.department !== null)?.department;
    assert.ok(department, 'Known-plate fixture has a verified department');
    const departmentFilter = `department=${encodeURIComponent(department)}&${plates}`;
    const departmentSummary = await get(`view=summary&metric=count&${departmentFilter}`);
    const departmentGrouped = await get(`view=grouped&group_by=department&metric=count&${departmentFilter}`);
    assert.equal(departmentGrouped.data.reduce((sum: number, row: CategoryRow) => sum + row.count, 0), departmentSummary.data.count);
    const empty = await get('view=grouped&group_by=make&metric=count&plate_numbers=__slice5_no_such_vehicle__');
    assert.deepEqual(empty.data, []);
    assert.equal(empty.meta.complete, true);
    const total = (await get('view=summary&metric=count')).data.count;
    for (const query of ['view=distinct&field=active', 'view=grouped&group_by=active&metric=count']) {
      const fleet = await get(query);
      assert.ok(fleet.data.length <= 2);
      assert.equal(fleet.meta.complete, true);
      assert.equal(new Set(fleet.data.map((row: CategoryRow) => row.value ?? row.group)).size, fleet.data.length);
      assert.equal(fleet.data.reduce((sum: number, row: CategoryRow) => sum + row.count, 0), total);
    }
    console.log(`Verified categories against fresh selected-fleet aggregates and fleet active counts totaling ${total}.`);
  } finally { await app.close(); }
});
