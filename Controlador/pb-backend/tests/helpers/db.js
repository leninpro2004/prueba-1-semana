const fs = require('fs');
const path = require('path');
require('./entorno');
const { pool, query } = require('../../src/db/pool');

const SEMILLA = fs.readFileSync(path.join(__dirname, 'semilla.sql'), 'utf8');

/**
 * La semilla inserta ids explícitos (OVERRIDING SYSTEM VALUE) para que los
 * tests puedan referirse a "el lote 1". Eso NO avanza la secuencia identity,
 * así que el primer INSERT automático chocaría con la clave primaria.
 *
 * Se resincronizan todas las secuencias de los 3 esquemas de una vez, en vez de
 * enumerarlas: así no hay que tocar esto cada vez que la semilla crezca.
 */
const RESINCRONIZAR_SECUENCIAS = `
DO $$
DECLARE r RECORD; maximo BIGINT;
BEGIN
  FOR r IN
    SELECT c.table_schema AS esquema, c.table_name AS tabla, c.column_name AS columna
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema IN ('inventario','terreno','finanzas')
      AND c.is_identity = 'YES'
      AND t.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) FROM %I.%I', r.columna, r.esquema, r.tabla) INTO maximo;
    EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN %I RESTART WITH %s',
                   r.esquema, r.tabla, r.columna, maximo + 1);
  END LOOP;
END $$;`;

/**
 * Deja la base en el estado exacto de la semilla.
 *
 * TRUNCATE + semilla en vez de recargar el DDL: recargar los 3 esquemas tarda
 * segundos y esto son milisegundos. Se llama antes de CADA test, así que un
 * test nunca depende de lo que hizo el anterior.
 */
async function resetear() {
  const { rows } = await query(
    `SELECT string_agg(format('%I.%I', schemaname, tablename), ', ') AS tablas
     FROM pg_tables WHERE schemaname IN ('inventario', 'terreno', 'finanzas')`
  );
  if (rows[0]?.tablas) {
    // Algunos controllers lanzan generarAlertasAutomaticas() sin await tras un
    // movimiento: puede seguir corriendo cuando empieza el test siguiente y chocar
    // con el TRUNCATE (deadlock 40P01). Se reintenta: al segundo intento ya terminó.
    for (let intento = 1; ; intento++) {
      try {
        await query(`TRUNCATE ${rows[0].tablas} RESTART IDENTITY CASCADE`);
        break;
      } catch (err) {
        if (err.code !== '40P01' || intento >= 5) throw err;
        await new Promise(r => setTimeout(r, 100 * intento));
      }
    }
  }
  await query(SEMILLA);
  await query(RESINCRONIZAR_SECUENCIAS);
}

/** Stock físico y reservado de un material (sumando todas las bodegas). */
async function stockDe(sku) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(inventario_bodega_cantidad_fisica), 0)    AS fisica,
            COALESCE(SUM(inventario_bodega_cantidad_reservada), 0) AS reservada
     FROM inventario.inventario_bodega WHERE material_sku = $1`,
    [sku]
  );
  return { fisica: parseFloat(rows[0].fisica), reservada: parseFloat(rows[0].reservada) };
}

/** Stock de un lote concreto, para comprobar el orden FIFO. */
async function stockDeLote(sku, loteId) {
  const { rows } = await query(
    `SELECT inventario_bodega_cantidad_fisica AS fisica
     FROM inventario.inventario_bodega WHERE material_sku = $1 AND lote_id_lote = $2`,
    [sku, loteId]
  );
  return rows.length ? parseFloat(rows[0].fisica) : null;
}

/** Cuántas filas hay en una tabla (para comprobar que algo NO se creó). */
async function contar(tabla, where = '', params = []) {
  const { rows } = await query(`SELECT count(*) AS n FROM ${tabla} ${where ? 'WHERE ' + where : ''}`, params);
  return parseInt(rows[0].n);
}

/**
 * El invariante central del sistema: lo que las reservas activas dicen tener
 * apartado tiene que coincidir con lo que el stock tiene marcado como reservado.
 * Devuelve las diferencias; vacío significa que cuadra.
 */
async function descuadresDeReservas() {
  const { rows } = await query(
    `WITH res AS (
       SELECT material_sku sku, SUM(reserva_inventario_cantidad_reservada) r
       FROM inventario.reserva_inventario
       WHERE reserva_inventario_estado_reserva = 'activa' GROUP BY 1),
     stk AS (
       SELECT material_sku sku, SUM(inventario_bodega_cantidad_reservada) s
       FROM inventario.inventario_bodega GROUP BY 1)
     SELECT COALESCE(res.sku, stk.sku) AS sku,
            COALESCE(res.r, 0) AS reservas, COALESCE(stk.s, 0) AS stock
     FROM res FULL OUTER JOIN stk ON stk.sku = res.sku
     WHERE COALESCE(res.r, 0) <> COALESCE(stk.s, 0)`
  );
  return rows;
}

async function cerrar() {
  await pool.end();
}

module.exports = { resetear, stockDe, stockDeLote, contar, descuadresDeReservas, cerrar, query };
