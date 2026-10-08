const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { api, bajar, levantar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Invariante: los montos se ocultan a jop y técnico (D50) EN EL BACKEND, no solo en la vista.
 *
 * Recorre como jop todos los GET a los que jop tiene acceso, con datos que SÍ
 * tienen precio (consumo de OT, factura, alerta de faltante con proveedor), y
 * falla si alguna respuesta trae un campo de precio, costo, valor o monto. Así, un
 * endpoint nuevo que olvide ocultarlos se detecta aquí y no en producción.
 *
 * Herramientas queda fuera a propósito: el usuario decidió no tocar esa área por
 * ahora (costo de mantenimiento; ver el Dropoff). Al resolverlo, quitar la exclusión.
 */

before(async () => {
  await db.resetear();
  // Datos con montos: consumo de OT (MAT-FIFO tiene precio 1000), factura y alerta de faltante
  const c = await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 } });
  assert.equal(c.status < 300, true, JSON.stringify(c.body));
  await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-CRIT', { body: { cantidad: 1 } });
  await db.query(
    `INSERT INTO inventario.factura_compra (factura_compra_numero_factura, factura_compra_monto_neto,
       factura_compra_fecha_emision, proveedor_id_proveedor)
     OVERRIDING SYSTEM VALUE VALUES ('FAC-TEST-1', 50000, '2026-06-01', 1)`
  );
  await db.query(
    `INSERT INTO inventario.alerta_faltante_pedido (alerta_faltante_pedido_estado, material_sku,
       alerta_faltante_pedido_cantidad_requerida, alerta_faltante_pedido_cantidad_disponible)
     VALUES ('activa', 'MAT-FIFO', 100, 25)`
  );
  // CU-103: diferenciales procesados (con impacto en CLP) en la OT 2, que está finalizada
  await db.query(
    `INSERT INTO inventario.material_orden_trabajo (material_sku, orden_trabajo_id_orden,
       material_orden_trabajo_consumo_estimado, material_orden_trabajo_consumo_real) VALUES ('MAT-FIFO', 2, 10, 12)`
  );
  const d = await api('POST', '/api/ordenes-trabajo/2/diferenciales');
  assert.equal(d.status, 200, JSON.stringify(d.body));
});
after(async () => { await bajar(); await db.cerrar(); });

/** Nombres de campo que son montos. Los conteos y banderas ("sin_precio") no lo son. */
// "impacto" y "clp" desde CU-103 (impacto_clp): sin ellos el detector no veía esos montos
const ES_MONTO = /(^|_)(precio|costo|costos|valor|monto|margen|rentabilidad|impacto|clp)(_|$)/i;
const NO_ES_MONTO = /^(sin_|productos_sin_|con_sin_)|(^|_)(origen_valor|nota_precio)$/i;

/** Campos de monto presentes en la respuesta, con su ruta (recorre objetos y arreglos). */
function camposDeMonto(v, ruta = '', out = new Set()) {
  if (Array.isArray(v)) { v.forEach(x => camposDeMonto(x, ruta + '[]', out)); return out; }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (ES_MONTO.test(k) && !NO_ES_MONTO.test(k)) out.add(`${ruta}.${k}`);
      camposDeMonto(x, `${ruta}.${k}`, out);
    }
  }
  return out;
}

const DESDE = 'desde=2020-01-01&hasta=2026-12-31';
const RUTAS = [
  '/api/materiales', '/api/materiales/MAT-FIFO', '/api/materiales/MAT-FIFO/comparar-proveedores',
  '/api/materiales/pinturas-sobrantes', '/api/materiales/catalogos/unidades', '/api/materiales/catalogos/categorias',
  '/api/movimientos', '/api/movimientos?paginado=1', '/api/movimientos/catalogos',
  `/api/reportes/movimientos?${DESDE}`, `/api/reportes/mermas?${DESDE}`, '/api/reportes/areas',
  '/api/reportes/consumo-area', `/api/reportes/consumo-area?${DESDE}`,
  '/api/reportes/consumo-area/grafico?agrupar=area', `/api/reportes/consumo-area/grafico?agrupar=area&${DESDE}`,
  '/api/reportes/consumo-area/grafico?agrupar=material', '/api/reportes/consumo-area/grafico?agrupar=mes',
  '/api/reportes/programacion-semanal', '/api/reportes/rotacion?desde=2026-01-01&hasta=2026-06-30',
  `/api/reportes/desviaciones?${DESDE}`,
  '/api/ordenes-trabajo', '/api/ordenes-trabajo/1/consumos', '/api/ordenes-trabajo/1/movimientos',
  '/api/ordenes-trabajo/1/comparativo', '/api/ordenes-trabajo/2/diferenciales',
  '/api/proveedores', '/api/proveedores/1', '/api/proveedores/metricas', '/api/proveedores/1/cumplimiento',
  '/api/alertas', '/api/alertas/tipos', '/api/alertas/reposicion', '/api/alertas/historial',
  '/api/alertas-faltantes', '/api/alertas-faltantes/1',
  '/api/alertas-faltantes/insumos-especiales?estado=todas',   // CU-122/124: jop ve la pestaña
  '/api/facturas', '/api/facturas/1', '/api/facturas/buscar-numero/FAC-TEST-1',
  '/api/pedidos', '/api/pedidos/1/checklist', '/api/reservas',
  '/api/seguimiento-pinturas', '/api/seguimiento-pinturas/reporte', '/api/seguimiento-pinturas/catalogo',
  '/api/seguimiento-pinturas/material/PIN-TEST',
  '/api/recetas', '/api/recetas/1', '/api/recetas/por-orden/1',
  '/api/bodegas', '/api/bodegas/1', '/api/bodegas/1/stock-consolidado',
  '/api/conteos', '/api/conteos/bodega/1/preparar', '/api/codigos/MAT-FIFO',
  '/api/notificaciones', '/api/notificaciones/resumen',
];

/** GET con un rol cualquiera (los helpers solo firman gerencia y jop). */
async function getComo(rol, ruta) {
  if (rol !== 'tecnico') return api('GET', ruta, { rol });
  const url = await levantar();
  const token = jwt.sign({ id: 2, username: 'jop.test', rol }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const r = await fetch(url + ruta, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe('Montos ocultos a jop y técnico en el backend (D50)', () => {
  for (const rol of ['jop', 'tecnico']) {
    test(`ningún GET accesible a ${rol} envía precios, costos, valores ni montos`, async () => {
      const fugas = [];
      let conDatos = 0;
      for (const ruta of RUTAS) {
        const r = await getComo(rol, ruta);
        if (r.status === 200) conDatos++;
        if (r.status >= 500) fugas.push(`${ruta}: error ${r.status}`);
        for (const campo of camposDeMonto(r.body)) fugas.push(`${ruta} → ${campo}`);
      }
      assert.deepEqual(fugas, []);
      // Que el recorrido pruebe algo: el rol recibe datos en la mayoría de las rutas (no solo 403)
      assert.ok(conDatos >= 30, `${rol} recibió datos en solo ${conDatos} rutas`);
    });
  }

  test('gerencia sí recibe los montos, y el detector los encuentra (no pasa por no buscar)', async () => {
    const consumo = await api('GET', '/api/reportes/consumo-area');
    assert.ok(consumo.body.consumos.every(c => 'precio_unitario' in c));
    const comp = await api('GET', '/api/ordenes-trabajo/1/comparativo');
    assert.ok('costo_total_real' in comp.body.resumen);
    const fac = await api('GET', '/api/facturas/1');
    assert.equal(parseFloat(fac.body.monto_neto), 50000);

    // Las rutas que tenían fugas: como gerencia, el detector tiene que ver montos en cada una
    for (const ruta of ['/api/reportes/consumo-area', '/api/reportes/consumo-area/grafico?agrupar=area',
                        '/api/reportes/consumo-area/grafico?agrupar=material', '/api/reportes/consumo-area/grafico?agrupar=mes',
                        '/api/ordenes-trabajo/1/consumos', '/api/ordenes-trabajo/1/comparativo',
                        '/api/facturas', '/api/facturas/1', '/api/alertas-faltantes/1',
                        '/api/ordenes-trabajo/2/diferenciales', `/api/reportes/desviaciones?${DESDE}`]) {
      const r = await api('GET', ruta);
      assert.ok(camposDeMonto(r.body).size > 0, `el detector no ve montos en ${ruta} como gerencia`);
    }
  });

  test('jop ve el consumo por área en cantidades, con porcentajes y orden por cantidad', async () => {
    const r = await api('GET', '/api/reportes/consumo-area/grafico?agrupar=area', { rol: 'jop' });
    assert.equal(r.body.medida, 'cantidad');
    assert.deepEqual(r.body.datasets.map(d => d.label), ['Cantidad']);
    assert.ok(r.body.total_cantidad > 0);
    assert.equal(r.body.areas.reduce((s, a) => s + a.porcentaje, 0), 100);
  });
});
