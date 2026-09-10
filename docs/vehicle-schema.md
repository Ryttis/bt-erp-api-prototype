# Verified vehicle mappings

Read-only discovery on 2026-09-09 used `SHOW FULL COLUMNS`, `SHOW INDEX`, bounded
SELECT examples, cardinality counts, and lookup-integrity counts. No database
changes were made. All tables below are in `infot_2`.

| Canonical field | Confirmed source / join |
|---|---|
| manufactured_at | `masinos.pag_metai`, `pag_menuo`, `pag_diena`; validated year/month/day construction |
| registration_date | `masinos.register_date` (DATE) |
| mileage | `masinos_latest_status.last_odometer`, joined on `masinos_id = masinos.id AND ar_priekaba = 0` |
| department | `masinos.priskirto_skyriaus_id → skyriai.id`, name `skyriai.skyrius` |
| group | `masinos.priskirto_poskyris_id → poskyriai.id`, name `poskyriai.poskyris` |
| market | `masinos.priskirto_rinka_id → rinkos.id`, name `rinkos.rinka` |
| consumer_name | Latest user relation `naudotojas → klientai.id`, name `firmos_pavadinimas` |
| lessor_name | Latest lease relation `lizinguotojas → klientai.id`, name `firmos_pavadinimas` |
| bank_name | Latest lease relation `bankas → klientai.id`, name `firmos_pavadinimas` |

The status table also stores trailers. Its column comment explicitly identifies
`ar_priekaba = 1` as trailer IDs. The unique index `(masinos_id, ar_priekaba)`
ensures at most one vehicle-status row when `ar_priekaba = 0`: observed 3,401
vehicle rows / 3,401 distinct vehicle IDs, with zero duplicate groups.
Lookup IDs are primary keys. All nonzero department/group/market assignments
matched their respective lookups across 4,205 vehicles. Market uses the vehicle's
explicit assignment, not `skyriai.rinka_id`; LGK058 has vehicle market 1 while
its department market is 0. No fallback or inherited market is inferred.

Both finance relations retain latest-known ordering `data_nuo DESC, id DESC`.
Zero foreign keys are null before lookup joins. Zero/partial/impossible dates
are null; manufacture components are never silently filled in. SQL validation
was tested with leap-day, non-leap-day, zero components, and April 31 examples.

## Small discovery snapshot

Odometers are operational readings, not permanent fixture constants. Integration
tests compare against fresh bounded source reads. Names and dates below were
observed before being used as fixture evidence.

| Plate | Manufactured | Registered | Mileage |
|---|---|---|---:|
| HOO756 | 2015-04-01 | null | 858219 |
| LGK058 | 2019-11-01 | null | 499249 |
| MUJ352 | 2023-08-01 | 2023-12-28 | 300523 |
| NHJ910 | 2025-01-13 | 2025-01-30 | null |
| NIR935 | 2025-02-01 | 2025-04-08 | 159717 |
| NJI449 | 2025-02-01 | 2025-04-29 | 148909 |

HOO756: department `Sandėlis LT`, group `Sandėlis1`, market null; consumer
`Baltic transline transport, UAB`, lessor `Baltic transline rental, UAB`, bank
`SEB bankas AB`. LGK058 market: `Europos rinka`. NHJ910 group: null.

## Representative query plan

Fleet mileage/rent filtering with consumer-name sorting and a three-field
projection took about 116 ms including endpoint overhead in the validation run.
EXPLAIN used `masinos_nr` for the vehicle scan, `eq_ref` on the status composite
unique key and lookup primary keys, and `masinos_id_data_nuo_idx` for latest
rental lookup. Temporary/filesort appeared for name sorting. No index change is
recommended from this measurement. Integration timings vary with network and
concurrent replica work.
