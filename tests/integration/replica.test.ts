import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../src/config.js';
import { createReplicaPool, checkReplicaConnectivity, readReplicaGrants, hasSelectOnlyInfot2Grants } from '../../src/db/replica.js';

test('live replica connects and account has SELECT-only grants on infot_2', async () => {
  const config = loadConfig();
  assert.equal(config.replica.database, 'infot_2', 'Integration verification requires the intended database');
  const pool = createReplicaPool(config.replica);
  try {
    await checkReplicaConnectivity(pool);
    const verified = hasSelectOnlyInfot2Grants(await readReplicaGrants(pool));
    // Never include raw grants (which may contain authentication hashes) in output.
    assert.equal(verified, true, 'Expected direct SELECT-only infot_2 grants; unexpected grants require private review');
  } finally {
    await pool.end();
  }
});
