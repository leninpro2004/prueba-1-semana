#!/usr/bin/env node
/**
 * Prepara la base de datos de test: la crea (si no existe) y le carga los 3
 * esquemas desde ddl/. Correr una vez, y repetir solo si cambia el DDL.
 *
 *   npm run test:preparar
 *
 * Usa node-postgres en vez de psql para no depender de dónde esté instalado
 * el cliente de PostgreSQL.
 */
require('./helpers/entorno');           // carga .env + .env.test y valida el nombre
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const BD   = process.env.DB_NAME;
const DDL  = path.resolve(__dirname, '..', '..', '..', 'ddl');
const CONN = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
};

// entorno.js silencia console.log; acá sí queremos ver el progreso
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

async function main() {
  log(`\nPreparando la base de test "${BD}"…\n`);

  const admin = new Client({ ...CONN, database: 'postgres' });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [BD]);
  if (rows.length === 0) {
    await admin.query(`CREATE DATABASE ${BD}`);
    log(`  ✔ base creada`);
  } else {
    log(`  · la base ya existía (se recargan los esquemas encima)`);
  }
  await admin.end();

  const cli = new Client({ ...CONN, database: BD });
  await cli.connect();
  // Sesión 15 (punto 27): los catálogos base van después de los DDL. Cargarlos aquí
  // comprueba que corren desde cero; los tests igual usan su semilla (resetear).
  for (const archivo of ['ddl_inventario.sql', 'ddl_terreno.sql', 'ddl_finanzas.sql', 'catalogos_inventario.sql']) {
    const ruta = path.join(DDL, archivo);
    if (!fs.existsSync(ruta)) throw new Error(`No se encontró ${ruta}`);
    await cli.query(fs.readFileSync(ruta, 'utf8'));
    log(`  ✔ ${archivo}`);
  }

  const { rows: tablas } = await cli.query(
    `SELECT count(*) AS n FROM information_schema.tables
     WHERE table_schema IN ('inventario','terreno','finanzas')`
  );
  await cli.end();

  log(`\nListo: ${tablas[0].n} tablas. Ya podés correr "npm test".\n`);
}

main().catch((err) => {
  process.stderr.write(`\n✖ ${err.message}\n\n`);
  process.exit(1);
});
