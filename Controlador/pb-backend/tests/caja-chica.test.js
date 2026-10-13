const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-23 (D86): material comprado con caja chica.
 *
 * Lo que protegen:
 *  - La entrada lleva el n° del gasto de Finanzas (referencia CC-<n°>) en vez de proveedor,
 *    precio y factura, y el motivo compra_caja_chica.
 *  - Entra como una compra: lote nuevo, no se devuelve al lote más antiguo como una devolución.
 *  - Desde Finanzas, una entrada CON gasto es una compra por caja chica; SIN gasto sigue siendo
 *    una devolución de consumo (CU-107).
 *  - Ningún rechazo mueve stock y las reservas no se tocan.
 *
 * Semilla: MAT-FIFO en la bodega 1, 30 físicas y 5 reservadas. Perfil 2 = jop.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const ENTRADA = '/api/movimientos/entrada';
const INTEGRACION = '/api/integracion/movimientos';
let clave = 0;

const cajaChica = (extra = {}) => ({
  sku: 'MAT-FIFO', bodega_id: 1, cantidad: 4, tipo_movimiento_id: 1,
  tipo_entrada: 'caja_chica', gasto_caja_chica_id: 12, descripcion_motivo: 'Ferretería del barrio', ...extra,
});

/** Movimientos de MAT-FIFO con su motivo, referencia y lote. */
async function movimientos() {
  const { rows } = await db.query(
    `SELECT mi.movimiento_inventario_cantidad::float AS cantidad, mi.lote_id_lote::int AS lote,
            mi.movimiento_inventario_referencia_origen AS referencia, mi.movimiento_inventario_modulo_origen AS modulo,
            mi.factura_compra_id_factura_compra AS factura, mot.movimiento_inventario_motivo_movimiento_nombre AS motivo
     FROM inventario.movimiento_inventario mi
     LEFT JOIN inventario.movimiento_inventario_motivo_movimiento mot
       ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     WHERE mi.material_sku = 'MAT-FIFO' ORDER BY mi.movimiento_inventario_id_movimiento`);
  return rows;
}

const lotesDeLaSemilla = async () =>
  (await db.query(`SELECT lote_id_lote::int AS id FROM inventario.inventario_bodega WHERE material_sku = 'MAT-FIFO'`)).rows.map(r => r.id);

describe('Entrada por caja chica desde Inventario', () => {
  test('suma al stock en un lote nuevo, con el motivo compra_caja_chica y la referencia CC-<n°>', async () => {
    const lotesAntes = await lotesDeLaSemilla();
    const r = await api('POST', ENTRADA, { rol: 'jop', body: cajaChica() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 34, reservada: 5 });
    const [m] = await movimientos();
    assert.equal(m.motivo, 'compra_caja_chica');
    assert.equal(m.referencia, 'CC-12');
    assert.equal(m.modulo, 'inventario');
    assert.equal(m.factura, null);
    assert.ok(!lotesAntes.includes(m.lote), 'lote nuevo, como una compra');
    assert.deepEqual(await db.descuadresDeReservas(), []);
    // El historial muestra el gasto como documento
    const h = (await api('GET', '/api/movimientos?paginado=1')).body.movimientos[0];
    assert.deepEqual([h.documento_tipo, h.documento_ref], ['origen', 'Caja chica: CC-12']);
  });

  test('sin n° de gasto, o con uno que no es un entero mayor que 0 → 400 y nada cambia', async () => {
    for (const gasto of [undefined, '', 0, -3, 'abc', 1.5, '99999999999']) {
      const r = await api('POST', ENTRADA, { rol: 'jop', body: cajaChica({ gasto_caja_chica_id: gasto }) });
      assert.equal(r.status, 400, `gasto ${gasto}`);
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await movimientos(), []);
  });

  test('no lleva proveedor, precio, factura ni fecha de pedido → 400', async () => {
    for (const extra of [{ proveedor_id: 1 }, { precio_unitario: 1000 }, { factura_numero: 'F-1', factura_fecha: '2026-10-01', proveedor_id: 1 },
                         { fecha_pedido: '2026-10-01' }]) {
      assert.equal((await api('POST', ENTRADA, { rol: 'jop', body: cajaChica(extra) })).status, 400, JSON.stringify(extra));
    }
    assert.deepEqual(await movimientos(), []);
  });

  test('el n° de gasto en una compra o devolución normal → 400', async () => {
    const r = await api('POST', ENTRADA, { rol: 'jop', body: cajaChica({ tipo_entrada: 'devolucion', descripcion_motivo: 'Obra X' }) });
    assert.equal(r.status, 400);
    assert.deepEqual(await movimientos(), []);
  });
});

describe('Entrada por caja chica desde Finanzas (CU-107)', () => {
  beforeEach(async () => {
    const r = await api('POST', '/api/integracion/reglas', { body: { modulo: 'finanzas', perfil_id: 2, tipos: ['entrada'] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });
  const envio = (extra = {}) => ({
    modulo: 'finanzas', tipo: 'entrada', sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1,
    gasto_caja_chica_id: 7, clave_envio: `cc-${++clave}`, ...extra,
  });

  test('con gasto: compra en un lote nuevo, motivo compra_caja_chica, referencia CC-<n°> (sin referencia aparte)', async () => {
    const lotesAntes = await lotesDeLaSemilla();
    const r = await api('POST', INTEGRACION, { rol: 'jop', body: envio() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.referencia, 'CC-7');
    const [m] = await movimientos();
    assert.deepEqual([m.motivo, m.referencia, m.modulo], ['compra_caja_chica', 'CC-7', 'finanzas']);
    assert.ok(!lotesAntes.includes(m.lote), 'lote nuevo');
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 33, reservada: 5 });
    const h = (await api('GET', '/api/movimientos?paginado=1')).body.movimientos[0];
    assert.equal(h.documento_ref, 'Finanzas: CC-7');
  });

  test('sin gasto sigue siendo una devolución de consumo al lote más antiguo', async () => {
    const lotesAntes = await lotesDeLaSemilla();
    const r = await api('POST', INTEGRACION, { rol: 'jop', body: envio({ gasto_caja_chica_id: undefined, referencia: 'OBRA-9' }) });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const [m] = await movimientos();
    assert.equal(m.motivo, 'devolucion_consumo');
    assert.ok(lotesAntes.includes(m.lote));
  });

  test('el mismo envío dos veces registra un solo movimiento', async () => {
    const body = envio();
    assert.equal((await api('POST', INTEGRACION, { rol: 'jop', body })).status, 201);
    const otra = await api('POST', INTEGRACION, { rol: 'jop', body });
    assert.equal(otra.status, 200);
    assert.equal(otra.body.repetido, true);
    assert.equal((await movimientos()).length, 1);
  });

  test('gasto desde Terreno, en una salida o inválido → 400 y nada cambia', async () => {
    await api('POST', '/api/integracion/reglas', { body: { modulo: 'terreno', perfil_id: 2, tipos: ['entrada', 'salida'] } });
    for (const extra of [{ modulo: 'terreno' }, { tipo: 'salida' }, { gasto_caja_chica_id: 'CC-7' }, { gasto_caja_chica_id: 0 }]) {
      const r = await api('POST', INTEGRACION, { rol: 'jop', body: envio(extra) });
      assert.equal(r.status, 400, JSON.stringify(extra));
      assert.equal(r.body.campos[0].campo, 'gasto_caja_chica_id');
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 30, reservada: 5 });
    assert.deepEqual(await movimientos(), []);
  });
});

describe('Alta rápida de un material de caja chica (F-23b)', () => {
  const ALTA = '/api/materiales/alta-rapida';

  test('genera un SKU válido, sin categoría ni umbrales y con su código de barras interno', async () => {
    const r = await api('POST', ALTA, { rol: 'jop', body: { nombre: 'Guantes de cabritilla talla L', unidad_medida_id: 1 } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.sku, /^MAT-GUANTE-\d{3}$/);
    assert.ok(r.body.sku.length >= 4 && r.body.sku.length <= 16);
    const { rows: [m] } = await db.query(
      `SELECT material_estado AS estado, material_es_rotativo AS rotativo, material_stock_minimo AS minimo,
              material_categoria_general_id_categoria_general AS general,
              material_categoria_funcional_id_categoria_funcional AS funcional,
              material_clasificacion_nivel_especifico_id AS nivel
       FROM inventario.material WHERE material_sku = $1`, [r.body.sku]);
    assert.deepEqual(m, { estado: 'activo', rotativo: true, minimo: null, general: null, funcional: null, nivel: null });
    assert.equal(await db.contar('inventario.material_codigo_barras', 'material_sku = $1', [r.body.sku]), 1);
  });

  test('dos altas con la misma primera palabra siguen el correlativo', async () => {
    const a = await api('POST', ALTA, { rol: 'gerencia', body: { nombre: 'Silicona transparente', unidad_medida_id: 1 } });
    const b = await api('POST', ALTA, { rol: 'gerencia', body: { nombre: 'Silicona negra', unidad_medida_id: 1 } });
    assert.equal(a.body.sku, 'MAT-SILICO-001');
    assert.equal(b.body.sku, 'MAT-SILICO-002');
  });

  test('sin nombre o sin unidad, o con una unidad que no existe → 400 y no se crea nada', async () => {
    const antes = await db.contar('inventario.material');
    for (const body of [{ unidad_medida_id: 1 }, { nombre: '   ', unidad_medida_id: 1 }, { nombre: 'Lija' }, { nombre: 'Lija', unidad_medida_id: 9999 }]) {
      const r = await api('POST', ALTA, { rol: 'jop', body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    assert.equal(await db.contar('inventario.material'), antes);
  });

  test('un nombre que ya existe (sin mayúsculas ni tildes) → 409 con el existente y no se crea nada', async () => {
    const antes = await db.contar('inventario.material');
    const r = await api('POST', ALTA, { rol: 'jop', body: { nombre: '  MATERIAL con dos  LÓTES ', unidad_medida_id: 1 } });
    // "LÓTES" con tilde se normaliza a "lotes": coincide con 'Material con dos lotes' de la semilla
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.existente.sku, 'MAT-FIFO');
    assert.equal(await db.contar('inventario.material'), antes);
  });
});
