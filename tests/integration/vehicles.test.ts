import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Vehicle } from '../../src/vehicles/repository.js';

test('live vehicles reconcile current selected-plate values with the replica', async () => {
  const app = buildApp(loadConfig(), undefined, { authenticate: false });
  async function get(query: string) {
    const response = await app.inject(`/vehicles?${query}`);
    assert.equal(response.statusCode, 200, 'Live vehicle endpoint must succeed');
    return response.json<{ data: Vehicle[]; meta: { total: number; last_page: number; page: number; per_page: number; sort: { field: string; direction: string } } }>();
  }
  try {
    const plates = ['HOO756', 'LGK058', 'MUJ352', 'NHJ910', 'NJI449', 'NIR935'];
    const direct = await app.replica.query<{ plate_number: string; rent_price: number | null; last_payment_amount: number | null }[]>(`SELECT m.masinos_nr AS plate_number, r.kaina AS rent_price, l.last_payment_amount FROM infot_2.masinos m LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id=(SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id=m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1) LEFT JOIN infot_2.masinu_priekabu_lizinguotojas l ON l.id=(SELECT ll.id FROM infot_2.masinu_priekabu_lizinguotojas ll WHERE ll.masinos_id=m.id ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1) WHERE m.masinos_nr IN (${plates.map(() => '?').join(',')})`, plates);
    const expected = new Map(direct.map((row) => [row.plate_number, { rent_price: row.rent_price === null ? null : Number(row.rent_price), last_payment_amount: row.last_payment_amount === null ? null : Number(row.last_payment_amount) }]));
    const all = await get(`plate_numbers=${plates.join(',')}`);
    assert.equal(all.meta.total, direct.length);
    assert.equal(all.data.length, direct.length);
    for (const [plate, current] of expected) {
      assert.equal(all.data.find((vehicle) => vehicle.plate_number === plate)?.rent_price, current.rent_price, `${plate} current rent_price`);
      assert.equal(all.data.find((vehicle) => vehicle.plate_number === plate)?.last_payment_amount, current.last_payment_amount, `${plate} current last_payment_amount`);
    }
    assert.deepEqual(all.data.map((v) => v.plate_number), [...expected.keys()].sort());
    const pairExpected = direct.filter((row) => ['NIR935', 'NJI449'].includes(row.plate_number)).sort((a, b) => a.plate_number.localeCompare(b.plate_number));
    const pair = await get('plate_numbers=NIR935,NJI449');
    assert.equal(pair.meta.total, pairExpected.length);
    assert.deepEqual(pair.data.map((v) => v.plate_number), pairExpected.map((row) => row.plate_number));
    const first = await get('plate_numbers=NIR935,NJI449&per_page=1');
    const second = await get('plate_numbers=NIR935,NJI449&per_page=1&page=2');
    assert.equal(first.meta.total, pairExpected.length);
    assert.equal(first.meta.last_page, Math.ceil(pairExpected.length));
    assert.deepEqual(first.data.map((v) => v.plate_number), pairExpected.slice(0, 1).map((row) => row.plate_number));
    assert.deepEqual(second.data.map((v) => v.plate_number), pairExpected.slice(1, 2).map((row) => row.plate_number));
    const ranked = await get('plate_numbers=NIR935,NJI449&sort_by=rent_price&sort_direction=desc');
    assert.deepEqual(ranked.data.map((v) => v.plate_number), [...pairExpected].sort((a, b) => a.rent_price === null ? 1 : b.rent_price === null ? -1 : (Number(b.rent_price) - Number(a.rent_price)) || a.plate_number.localeCompare(b.plate_number)).map((row) => row.plate_number));
    const substring = await get('plate_numbers=NIR935,NJI449&plate_number=nir');
    assert.deepEqual(substring.data.map((v) => v.plate_number), pairExpected.filter((row) => row.plate_number.toLowerCase().includes('nir')).map((row) => row.plate_number));
    console.log('Reconciled selected-plate current values, pagination and sorting with the replica.');
  } finally { await app.close(); }
});
