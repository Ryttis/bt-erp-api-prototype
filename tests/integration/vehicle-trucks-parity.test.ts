import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Vehicle } from '../../src/vehicles/repository.js';

type Parity = Pick<Vehicle, 'id' | 'plate_number' | 'active' | 'inactive_since' | 'owner_id' | 'owner_name' | 'ownership_status' | 'technical_inspection_valid_until' | 'civil_insurance_valid_until'>;
const fields = 'id,plate_number,active,inactive_since,owner_id,owner_name,ownership_status,technical_inspection_valid_until,civil_insurance_valid_until';
const date = (value: unknown) => typeof value === 'string' && /^[1-9]\d{3}-\d{2}-\d{2}$/.test(value) ? value : null;

test('live migrated trucks fields reconcile with fresh replica reads and filter consistently', async () => {
  const app = buildApp(loadConfig(), undefined, { authenticate: false });
  async function get(query: string) {
    const response = await app.inject(`/vehicles?${query}`);
    assert.equal(response.statusCode, 200, 'Live vehicle endpoint must succeed');
    return response.json<{ data: Parity[]; meta: { total: number; last_page: number } }>();
  }
  try {
    const plates = ['HOO756', 'LGK058', 'MUJ352', 'NHJ910', 'NJI449', 'NIR935'];
    const direct = await app.replica.query<Record<string, unknown>[]>(`SELECT m.id, CAST(m.nebedirba_nuo AS CHAR) AS inactive_since,
      NULLIF(o.savininkas, 0) AS owner_id, oc.firmos_pavadinimas AS owner_name, ost.pavadinimas AS ownership_status,
      (SELECT CAST(MAX(g.galioja_iki) AS CHAR) FROM infot_2.masinu_galiojimai g WHERE g.masinos_id = m.id AND g.ispejimo_id = 3 AND g.neaktualus = 0) AS technical_inspection_valid_until,
      (SELECT CAST(MAX(g.galioja_iki) AS CHAR) FROM infot_2.masinu_galiojimai g WHERE g.masinos_id = m.id AND g.ispejimo_id = 8 AND g.neaktualus = 0) AS civil_insurance_valid_until
      FROM infot_2.masinos m
      LEFT JOIN infot_2.masinu_priekabu_savininkas o ON o.id = (SELECT x.id FROM infot_2.masinu_priekabu_savininkas x WHERE x.masinos_id = m.id ORDER BY x.data_nuo DESC, x.id DESC LIMIT 1)
      LEFT JOIN infot_2.klientai oc ON oc.id = NULLIF(o.savininkas, 0)
      LEFT JOIN infot_2.tipai_sarasai_visi ost ON ost.id = NULLIF(o.statusas, 0)
      WHERE m.masinos_nr IN (${plates.map(() => '?').join(',')})`, plates);
    const rows = await get(`plate_numbers=${plates.join(',')}&fields=${fields}`);
    assert.equal(rows.meta.total, direct.length);
    for (const source of direct) {
      const vehicle = rows.data.find((row) => row.id === Number(source.id));
      assert.ok(vehicle, 'selected vehicle returned');
      assert.equal(vehicle.inactive_since, date(source.inactive_since));
      assert.equal(vehicle.owner_id, source.owner_id === null ? null : Number(source.owner_id));
      assert.equal(vehicle.owner_name, source.owner_name ?? null);
      assert.equal(vehicle.ownership_status, source.ownership_status ?? null);
      assert.equal(vehicle.technical_inspection_valid_until, date(source.technical_inspection_valid_until));
      assert.equal(vehicle.civil_insurance_valid_until, date(source.civil_insurance_valid_until));
    }

    const inactive = await get(`active=0&inactive_since_from=2024-01-01&inactive_since_to=2024-12-31&fields=${fields}&per_page=200`);
    assert.ok(inactive.data.every((v) => !v.active && v.inactive_since !== null && v.inactive_since >= '2024-01-01' && v.inactive_since <= '2024-12-31'));
    const inspection = await get(`technical_inspection_valid_until_from=2026-01-01&technical_inspection_valid_until_to=2026-12-31&fields=${fields}&per_page=200`);
    assert.ok(inspection.meta.total > 0);
    assert.ok(inspection.data.every((v) => v.technical_inspection_valid_until! >= '2026-01-01' && v.technical_inspection_valid_until! <= '2026-12-31'));
    const insurance = await get(`civil_insurance_valid_until_from=2026-01-01&civil_insurance_valid_until_to=2026-12-31&fields=${fields}&per_page=200`);
    assert.ok(insurance.data.every((v) => v.civil_insurance_valid_until! >= '2026-01-01' && v.civil_insurance_valid_until! <= '2026-12-31'));

    const statuses = (await app.inject('/vehicles?view=distinct&field=ownership_status')).json<{ data: { value: string | null; count: number }[] }>().data;
    const status = statuses.find((row) => row.value !== null);
    assert.ok(status, 'at least one ownership status exists');
    const byStatus = await get(`status=${encodeURIComponent(status.value!.toUpperCase())}&fields=${fields}&per_page=200`);
    assert.equal(byStatus.meta.total, status.count, 'legacy status alias matches case-insensitively and agrees with distinct counts');
    assert.ok(byStatus.data.every((v) => v.ownership_status?.toLowerCase() === status.value!.toLowerCase()));

    const owned = rows.data.find((row) => row.owner_name);
    if (owned) {
      const fragment = owned.owner_name!.slice(1, 6).toLowerCase();
      const byOwner = await get(`owner=${encodeURIComponent(fragment)}&fields=${fields}&per_page=200`);
      assert.ok(byOwner.meta.total > 0);
      assert.ok(byOwner.data.every((v) => v.owner_name!.toLowerCase().includes(fragment)));
    }
    console.log('Reconciled migrated trucks fields and filters with the replica.');
  } finally { await app.close(); }
});
