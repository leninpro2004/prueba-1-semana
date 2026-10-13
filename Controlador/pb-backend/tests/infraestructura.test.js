const { test, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { query } = require('../src/db/pool');
const { conTransaccion } = require('../src/db/tx');

/**
 * Configuración para la nube (sección 8.3 del plan de la fase de cierre).
 *
 * Lo que se protege: cada conexión trae su schema, la hora de Chile y un tope por
 * consulta, también dentro de una transacción (C-03, C-04, C-05); Node corre en hora
 * de Chile aunque el servidor esté en UTC; y /api/health mira la BD (C-09).
 */

after(async () => { await bajar(); await db.cerrar(); });

const ajustes = async (ejecutar) => (await ejecutar(
  `SELECT current_setting('search_path')      AS search_path,
          current_setting('TimeZone')         AS timezone,
          current_setting('statement_timeout') AS statement_timeout`
)).rows[0];

describe('cada conexión del pool', () => {
  test('trae schema, zona horaria y tope por consulta', async () => {
    const a = await ajustes(query);
    assert.equal(a.search_path, 'inventario');
    assert.equal(a.timezone, 'America/Santiago');
    assert.equal(a.statement_timeout, '30s');
  });

  test('también dentro de una transacción', async () => {
    const a = await conTransaccion(client => ajustes(sql => client.query(sql)));
    assert.equal(a.search_path, 'inventario');
    assert.equal(a.timezone, 'America/Santiago');
  });
});

test('Node corre en hora de Chile', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'America/Santiago');
});

test('/api/health consulta la BD', async () => {
  const r = await api('GET', '/api/health', { sinToken: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.db, 'ok');
});
