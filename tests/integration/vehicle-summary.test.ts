import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';

const rentalJoin = `LEFT JOIN infot_2.masinu_priekabu_naudotojas r ON r.id = (SELECT ru.id FROM infot_2.masinu_priekabu_naudotojas ru WHERE ru.masinos_id = m.id ORDER BY ru.data_nuo DESC, ru.id DESC LIMIT 1)`;
const leaseJoin = `LEFT JOIN infot_2.masinu_priekabu_lizinguotojas l ON l.id = (SELECT ll.id FROM infot_2.masinu_priekabu_lizinguotojas ll WHERE ll.masinos_id = m.id ORDER BY ll.data_nuo DESC, ll.id DESC LIMIT 1)`;

test('live vehicle summaries match replica values sampled at execution time', async () => {
  const app = buildApp(loadConfig(), undefined, { authenticate: false });
  async function verify(label: string, query: string, sql: string, values: unknown[] = []) {
    const row = (await app.replica.query<Record<string, unknown>[]>(sql, values))[0];
    const expected = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value === null ? null : Number(value)]));
    const response = await app.inject(`/vehicles?view=summary&${query}`);
    assert.equal(response.statusCode, 200, label);
    assert.deepEqual(response.json(), { data: expected, meta: { view: 'summary', complete: true } }, label);
    console.log(`${label}: reconciled against a fresh replica aggregate`);
  }
  try {
    await verify('Complete vehicle count', 'metric=count', 'SELECT COUNT(*) AS count FROM infot_2.masinos m');
    await verify('Complete rental sum', 'metric=sum:rent_price', `SELECT ROUND(SUM(r.kaina), 2) AS sum_rent_price FROM infot_2.masinos m ${rentalJoin}`);
    await verify('Complete last payment sum', 'metric=sum:last_payment_amount', `SELECT ROUND(SUM(l.last_payment_amount), 2) AS sum_last_payment_amount FROM infot_2.masinos m ${leaseJoin}`);
    await verify('Selected-plate rental sum', 'plate_numbers=HOO756,LGK058&metric=sum:rent_price', `SELECT ROUND(SUM(r.kaina), 2) AS sum_rent_price FROM infot_2.masinos m ${rentalJoin} WHERE m.masinos_nr IN (?, ?)`, ['HOO756', 'LGK058']);
    await verify('Selected-plate rental sum and max payment', 'plate_numbers=NHJ910,MUJ352&metric=sum:rent_price&metric=max:last_payment_amount', `SELECT ROUND(SUM(r.kaina), 2) AS sum_rent_price, ROUND(MAX(l.last_payment_amount), 2) AS max_last_payment_amount FROM infot_2.masinos m ${rentalJoin} ${leaseJoin} WHERE m.masinos_nr IN (?, ?)`, ['NHJ910', 'MUJ352']);
    await verify('Zero included in all rental aggregates', 'plate_numbers=NIR935,NJI449&metric=count&metric=sum:rent_price&metric=avg:rent_price&metric=min:rent_price&metric=max:rent_price',
      `SELECT COUNT(*) AS count, ROUND(SUM(r.kaina), 2) AS sum_rent_price, ROUND(AVG(r.kaina), 2) AS avg_rent_price, ROUND(MIN(r.kaina), 2) AS min_rent_price, ROUND(MAX(r.kaina), 2) AS max_rent_price FROM infot_2.masinos m ${rentalJoin} WHERE m.masinos_nr IN (?, ?)`, ['NIR935', 'NJI449']);
    await verify('Case-insensitive filtered sum', 'plate_numbers=HOO756,LGK058&plate_number=hoo&metric=sum:rent_price', `SELECT ROUND(SUM(r.kaina), 2) AS sum_rent_price FROM infot_2.masinos m ${rentalJoin} WHERE m.masinos_nr IN (?, ?) AND LOWER(m.masinos_nr) LIKE LOWER(?) ESCAPE '!'`, ['HOO756', 'LGK058', '%hoo%']);
    await verify('Empty dataset', 'plate_numbers=__slice4_no_such_vehicle__&metric=count&metric=sum:rent_price&metric=avg:rent_price&metric=min:last_payment_amount&metric=max:last_payment_amount',
      `SELECT COUNT(*) AS count, ROUND(SUM(r.kaina), 2) AS sum_rent_price, ROUND(AVG(r.kaina), 2) AS avg_rent_price, ROUND(MIN(l.last_payment_amount), 2) AS min_last_payment_amount, ROUND(MAX(l.last_payment_amount), 2) AS max_last_payment_amount FROM infot_2.masinos m ${rentalJoin} ${leaseJoin} WHERE m.masinos_nr = ?`, ['__slice4_no_such_vehicle__']);
  } finally { await app.close(); }
});
