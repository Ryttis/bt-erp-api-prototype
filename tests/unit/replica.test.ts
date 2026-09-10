import assert from 'node:assert/strict';
import { test } from 'node:test';
import mariadb from 'mariadb';
import { createReplicaPool, checkReplicaConnectivity, readReplicaGrants, hasSelectOnlyInfot2Grants, queryReadOnly, type ReplicaPool } from '../../src/db/replica.js';

test('verification issues only the expected read queries', async () => {
  const queries: string[] = [];
  const pool = { query: async (sql: string) => { queries.push(sql); return [{ grant: 'example' }]; }, end: async () => {} } as ReplicaPool;
  await checkReplicaConnectivity(pool);
  assert.deepEqual(await readReplicaGrants(pool), ['example']);
  assert.deepEqual(queries, [
    'SELECT VERSION() AS version, CURRENT_USER() AS currentUser, DATABASE() AS databaseName',
    'SHOW GRANTS FOR CURRENT_USER()',
  ]);
});

test('repository read boundary permits only read statements and never calls the pool for writes', async () => {
  let calls = 0;
  const pool = { query: async () => { calls++; return [{ value: 1 }]; }, end: async () => {} } as ReplicaPool;
  assert.deepEqual(await queryReadOnly(pool, ' SELECT 1'), [{ value: 1 }]);
  await assert.rejects(queryReadOnly(pool, 'UPDATE infot_2.masinos SET x=1'), /not read-only/);
  await assert.rejects(queryReadOnly(pool, 'DELETE FROM infot_2.masinos'), /not read-only/);
  assert.equal(calls, 1);
});

test('verification errors do not expose driver details', async () => {
  const pool = { query: async () => { throw new Error('secret-account-password'); }, end: async () => {} } as ReplicaPool;
  await assert.rejects(checkReplicaConnectivity(pool), { message: 'Replica connectivity check failed: [{"name":"Error"}]' });
  await assert.rejects(readReplicaGrants(pool), { message: 'Replica grant inspection failed: [{"name":"Error"}]' });
});

test('grants require direct SELECT-only access on infot_2 and reject broader privileges or roles', () => {
  const select = 'GRANT SELECT ON `infot_2`.* TO `reader`@`%`';
  assert.equal(hasSelectOnlyInfot2Grants(['GRANT USAGE ON *.* TO `reader`@`%`', select]), true);
  for (const grants of [[], ['GRANT USAGE ON *.* TO `reader`@`%`'], [select + ' WITH GRANT OPTION'], [select, 'GRANT `role` TO `reader`@`%`'], [select, 'GRANT SELECT ON *.* TO `reader`@`%`'], ['GRANT SELECT, INSERT ON `infot_2`.* TO `reader`@`%`'], ['GRANT ALL PRIVILEGES ON `infot_2`.* TO `reader`@`%`']]) {
    assert.equal(hasSelectOnlyInfot2Grants(grants), false);
  }
});


test('pool factory passes connection configuration and bounded options to the driver', (t) => {
  const config = { host: 'example.invalid', port: 3307, database: 'infot_2', user: 'test', password: 'test', ssl: false, connectionLimit: 2 };
  const fake = { query: async () => [], end: async () => {} };
  const create = t.mock.method(mariadb, 'createPool', (options: unknown) => {
    assert.deepEqual(options, { ...config, minimumIdle: 0, connectTimeout: 5000, acquireTimeout: 10000, idleTimeout: 60, queryTimeout: 30000 });
    return fake;
  });
  assert.equal(createReplicaPool(config), fake);
  assert.equal(create.mock.callCount(), 1);
});


test('safe diagnostics preserve nested pool causes without sensitive error properties', async () => {
  const cause = Object.assign(new Error('Access denied for user private-user at private-host (password: private-password)'), {
    name: 'SqlError', code: 'ER_ACCESS_DENIED_ERROR', errno: 1045, sqlState: '28000', fatal: true,
    sql: 'SELECT private-payload', uri: 'mariadb://private-user:private-password@private-host',
  });
  const outer = Object.assign(new Error('pool failed with private-values'), {
    name: 'SqlError', code: 'ER_GET_CONNECTION_TIMEOUT', errno: 45028, sqlState: 'HY000', fatal: false, cause,
  });
  const pool = { query: async () => { throw outer; }, end: async () => {} } as ReplicaPool;
  await assert.rejects(checkReplicaConnectivity(pool), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.cause, undefined);
    assert.match(error.message, /ER_GET_CONNECTION_TIMEOUT/);
    assert.match(error.message, /ER_ACCESS_DENIED_ERROR/);
    assert.match(error.message, /1045/);
    assert.match(error.message, /28000/);
    assert.match(error.message, /"fatal":true/);
    assert.doesNotMatch(error.stack! + JSON.stringify(error), /private-|mariadb:\/\/|SELECT/);
    return true;
  });
});

test('timeout, TLS, network and query codes remain distinguishable', async () => {
  for (const code of ['ER_CONNECTION_TIMEOUT', 'ER_SERVER_SSL_DISABLED', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'ER_PARSE_ERROR']) {
    const pool = { query: async () => { throw Object.assign(new Error('sql: sensitive payload'), { code }); }, end: async () => {} } as ReplicaPool;
    await assert.rejects(checkReplicaConnectivity(pool), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(code));
      assert.doesNotMatch(error.message, /sensitive|payload/);
      return true;
    });
  }
});

test('only recognized safe messages survive; cyclic causes terminate', async () => {
  const cause = new Error('self-signed certificate');
  cause.cause = cause;
  const pool = { query: async () => { throw cause; }, end: async () => {} } as ReplicaPool;
  await assert.rejects(checkReplicaConnectivity(pool), /self-signed certificate/);
});
