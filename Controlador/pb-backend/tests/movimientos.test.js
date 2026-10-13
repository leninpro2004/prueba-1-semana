const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar, firmaGerencia } = require('./helpers/api');
const db = require('./helpers/db');
const { compra } = require('./helpers/compra');   // D66: una compra lleva proveedor, precio, pedido y factura

/**
 * Entradas, salidas y reversiones.
 *
 * Lo que se busca proteger acá es el INVARIANTE: el stock que queda en la base
 * después de cada operación. Los mensajes pueden cambiar; los números no.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

describe('Autenticación', () => {
  test('sin token devuelve 401', async () => {
    const r = await api('GET', '/api/materiales', { sinToken: true });
    assert.equal(r.status, 401);
  });

  test('con token válido devuelve 200', async () => {
    const r = await api('GET', '/api/materiales');
    assert.equal(r.status, 200);
  });
});

describe('Registrar entrada', () => {
  test('suma al stock y crea el movimiento', async () => {
    const antes = await db.stockDe('MAT-FIFO');

    const r = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 7, tipo_movimiento_id: 1, numero_lote: 'LOTE-NUEVO-TEST', ...compra() },
    });

    assert.equal(r.status, 201);
    const despues = await db.stockDe('MAT-FIFO');
    assert.equal(despues.fisica, antes.fisica + 7);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 1);
  });

  test('rechaza cantidad no positiva y no toca el stock', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const r = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 0, tipo_movimiento_id: 1 },
    });
    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
  });

  test('D66: la misma factura del mismo proveedor y fecha se reutiliza (una factura, varios productos)', async () => {
    const factura = { factura_numero: 'F-DUP-001', factura_fecha: '2026-06-01', proveedor_id: 1 };
    const primera = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, numero_lote: 'L1', ...compra(factura) },
    });
    assert.equal(primera.status, 201, JSON.stringify(primera.body));
    const segunda = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 2, tipo_movimiento_id: 1, numero_lote: 'L2', ...compra(factura) },
    });
    assert.equal(segunda.status, 201, JSON.stringify(segunda.body));
    assert.equal(await db.contar('inventario.factura_compra', `factura_compra_numero_factura = 'F-DUP-001'`), 1);
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT factura_compra_id_factura_compra)::int AS n FROM inventario.movimiento_inventario
       WHERE factura_compra_id_factura_compra IS NOT NULL AND material_sku IN ('MAT-FIFO', 'MAT-UNO')`);
    assert.equal(rows[0].n, 1, 'las dos entradas apuntan a la misma factura');
  });

  test('una factura ya registrada con OTRO proveedor se rechaza (409) SIN dejar el lote huérfano', async () => {
    // Este es el bug que se corrigió al poner registrarEntrada en transacción:
    // el lote se creaba antes de validar la factura, así que cada 409 dejaba basura.
    const primera = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, numero_lote: 'L1',
              ...compra({ factura_numero: 'F-DUP-002', factura_fecha: '2026-06-01', proveedor_id: 1 }) },
    });
    assert.equal(primera.status, 201);

    const lotesAntes = await db.contar('inventario.lote');
    const segunda = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, numero_lote: 'L2',
              ...compra({ factura_numero: 'F-DUP-002', factura_fecha: '2026-06-01', proveedor_id: 2 }) },
    });

    assert.equal(segunda.status, 409);
    assert.match(segunda.body.error, /otro proveedor/);
    assert.equal(await db.contar('inventario.lote'), lotesAntes, 'el 409 no debe dejar un lote creado');
  });

  test('una factura sin proveedor se rechaza con 400, no con 500', async () => {
    // factura_compra.proveedor_id_proveedor es NOT NULL. Antes de esta validación
    // el INSERT reventaba y el usuario veía "Error interno del servidor".
    const r = await api('POST', '/api/movimientos/entrada', {
      body: {
        sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 1,
        factura_numero: 'F-SIN-PROV', factura_fecha: '2026-06-01',
      },
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /proveedor/i);
  });

  test('una factura sin fecha se rechaza', async () => {
    const r = await api('POST', '/api/movimientos/entrada', {
      body: {
        sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 1,
        factura_numero: 'F-SIN-FECHA', proveedor_id: 1,
      },
    });
    assert.equal(r.status, 400);
  });
});

describe('Registrar salida', () => {
  test('descuenta por FIFO: primero el lote más antiguo', async () => {
    // MAT-FIFO: lote 1 (viejo) 10 libres, lote 2 (nuevo) 20 físicas con 5 reservadas.
    const r = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 12, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    assert.equal(r.status, 201);
    assert.equal(await db.stockDeLote('MAT-FIFO', 1), 0,  'el lote viejo debe vaciarse primero');
    assert.equal(await db.stockDeLote('MAT-FIFO', 2), 18, 'y el resto sale del lote nuevo');
  });

  test('no permite consumir stock reservado', async () => {
    // Hay 30 físicas pero 5 están reservadas: el máximo disponible es 25.
    const antes = await db.stockDe('MAT-FIFO');
    const r = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 26, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes, 'un rechazo no puede mover stock');
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('D61: sin motivo, con un motivo inexistente o de otro flujo (despacho) → 400 y no se mueve nada', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const salida = (extra) => api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, ...extra },
    });
    const sinMotivo = await salida({});
    assert.equal(sinMotivo.status, 400);
    assert.match(sinMotivo.body.error, /motivo/);
    assert.equal((await salida({ motivo_id: 999 })).status, 400);
    const despacho = await salida({ motivo_id: 7 });   // despacho_venta: solo desde Instalaciones (CU-127)
    assert.equal(despacho.status, 400);
    assert.match(despacho.body.error, /Instalaciones/);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('una merma sin enlace de evidencia se rechaza', async () => {
    const r = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 3 },
    });
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /evidencia/i);
  });

  test('una merma con evidencia inválida se rechaza', async () => {
    const r = await api('POST', '/api/movimientos/salida', {
      body: {
        sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 3,
        evidencia_url: 'no-es-una-url',
      },
    });
    assert.equal(r.status, 400);
  });

  test('la merma de un material crítico hecha por un JOP queda pendiente de aprobación', async () => {
    const r = await api('POST', '/api/movimientos/salida', {
      rol: 'jop',
      body: {
        sku: 'MAT-CRIT', bodega_id: 1, cantidad: 2, tipo_movimiento_id: 2, motivo_id: 3,
        evidencia_url: 'https://drive.google.com/evidencia',
      },
    });

    assert.equal(r.status, 201);
    assert.equal(r.body.pendiente_aprobacion, true);
    assert.equal(
      await db.contar('inventario.movimiento_inventario', "movimiento_inventario_estado = 'pendiente_aprobacion'"),
      1
    );
  });
});

describe('Listado de movimientos', () => {
  test('devuelve descripción de motivo y evidencia', async () => {
    // Estas dos columnas venían de una segunda consulta envuelta en try/catch.
    // Ahora salen del SELECT principal: el test protege ese cambio.
    await api('POST', '/api/movimientos/salida', {
      body: {
        sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 3,
        evidencia_url: 'https://drive.google.com/evidencia-test',
        descripcion_motivo: 'Se cayó del estante',
      },
    });

    const r = await api('GET', '/api/movimientos');
    assert.equal(r.status, 200);
    const mov = r.body[0];
    assert.equal(mov.evidencia_url, 'https://drive.google.com/evidencia-test');
    assert.equal(mov.descripcion_motivo, 'Se cayó del estante');
  });

  test('el filtro por OT solo trae los movimientos de esa orden', async () => {
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 2, bodega_id: 1 } });
    await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-CRIT', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    const todos = await api('GET', '/api/movimientos');
    const deLaOT = await api('GET', '/api/movimientos?orden_trabajo_id=1');

    assert.equal(todos.body.length, 2);
    assert.equal(deLaOT.body.length, 1);
    assert.equal(deLaOT.body[0].sku, 'MAT-FIFO');
  });
});

/** CU-44: revertir con la firma de gerencia (CU-42, F-11; el helper firma solo) o la que se pase, para probar rechazos. */
const revertir = (id, firma = null) =>
  api('POST', `/api/movimientos/${id}/revertir`, firma ? { firma } : {});

/** Movimiento tal como quedó en la BD (el inverso se busca por id_revertido). */
async function movimiento(where, params) {
  const { rows } = await db.query(
    `SELECT mi.movimiento_inventario_id_movimiento AS id,
            mi.movimiento_inventario_estado        AS estado,
            mi.movimiento_inventario_cantidad::float AS cantidad,
            mi.material_sku AS sku, mi.bodega_id_bodega AS bodega, mi.lote_id_lote AS lote,
            mi.usuario_id_usuario AS usuario, mi.orden_trabajo_id_orden AS ot,
            mi.factura_compra_id_factura_compra AS factura,
            mi.movimiento_inventario_id_revertido AS revierte_a,
            tm.movimiento_inventario_tipo_movimiento_nombre AS tipo,
            mot.movimiento_inventario_motivo_movimiento_nombre AS motivo
     FROM inventario.movimiento_inventario mi
     JOIN inventario.movimiento_inventario_tipo_movimiento tm
       ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
     LEFT JOIN inventario.movimiento_inventario_motivo_movimiento mot
       ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
     WHERE ${where}`,
    params
  );
  return rows;
}
const inversosDe = (id) => movimiento('mi.movimiento_inventario_id_revertido = $1', [id]);
const original   = async (id) => (await movimiento('mi.movimiento_inventario_id_movimiento = $1', [id]))[0];

describe('Revertir movimiento (CU-44)', () => {
  const salidaDe = (cantidad, extra = {}) => api('POST', '/api/movimientos/salida', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad, tipo_movimiento_id: 2, motivo_id: 2, ...extra },
  });

  test('revertir una salida devuelve el stock y registra la entrada inversa', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const salida = await salidaDe(4);
    assert.equal(salida.status, 201);
    const id = salida.body.movimiento_id;

    const r = await revertir(id);
    assert.equal(r.status, 200);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica, 'el total debe volver al valor original');

    assert.equal((await original(id)).estado, 'revertido');
    const inv = await inversosDe(id);
    assert.equal(inv.length, 1);
    assert.equal(String(inv[0].id), String(r.body.inverso_id));
    assert.equal(inv[0].tipo, 'entrada');
    assert.equal(inv[0].cantidad, 4);
    assert.equal(inv[0].sku, 'MAT-FIFO');
    assert.equal(String(inv[0].bodega), '1');
    // La salida no guarda lote: se repone al más antiguo y el inverso registra cuál fue
    assert.ok(inv[0].lote, 'el inverso registra el lote donde se repuso el stock');
    assert.equal(inv[0].estado, 'completado');
    assert.equal(inv[0].motivo, 'reverso_autorizado');
    assert.equal(String(inv[0].usuario), '1', 'el inverso lo registra quien revierte');
  });

  test('revertir una entrada descuenta el stock y registra la salida inversa en el mismo lote', async () => {
    const entrada = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, numero_lote: 'LOTE-REV', ...compra() },
    });
    assert.equal(entrada.status, 201);
    const id = entrada.body.movimiento_id;
    const ent = await original(id);
    const antes = await db.stockDeLote('MAT-UNO', ent.lote);

    const r = await revertir(id);
    assert.equal(r.status, 200);
    assert.equal(await db.stockDeLote('MAT-UNO', ent.lote), antes - 5);

    const [inv] = await inversosDe(id);
    assert.equal(inv.tipo, 'salida');
    assert.equal(inv.cantidad, 5);
    assert.equal(String(inv.lote), String(ent.lote));
    assert.equal(inv.factura, null, 'el inverso no copia la factura del original');
    assert.deepEqual(await db.descuadresDeReservas(), []);
  });

  test('sin firma, firma de otra acción, vencida o ya usada: 428 y nada cambia', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const a = (await salidaDe(1)).body.movimiento_id;
    const b = (await salidaDe(1)).body.movimiento_id;
    // Una firma usada para revertir b no sirve después para revertir a
    const usada = firmaGerencia('revertir_movimiento');
    assert.equal((await revertir(b, usada)).status, 200);
    const trasSalidas = await db.stockDe('MAT-FIFO');

    const sinFirma = await api('POST', `/api/movimientos/${a}/revertir`, { sinFirma: true });
    assert.equal(sinFirma.status, 428);
    assert.equal(sinFirma.body.requiere_firma, 'revertir_movimiento');
    assert.equal((await revertir(a, firmaGerencia('aprobar_merma'))).status, 428, 'firma de otra acción');
    assert.equal((await revertir(a, firmaGerencia('revertir_movimiento', { iat: Math.floor(Date.now() / 1000) - 600 }, { expiresIn: 300 }))).status,
      428, 'firma vencida');
    assert.equal((await revertir(a, 'no-es-un-token')).status, 428);
    assert.equal((await revertir(a, usada)).status, 428, 'firma ya usada');

    assert.deepEqual(await db.stockDe('MAT-FIFO'), trasSalidas);
    assert.notDeepEqual(trasSalidas, antes);
    assert.equal((await original(a)).estado, 'completado');
    assert.equal((await inversosDe(a)).length, 0);
  });

  test('no se puede revertir dos veces', async () => {
    const id = (await salidaDe(2)).body.movimiento_id;
    assert.equal((await revertir(id)).status, 200);
    const stock = await db.stockDe('MAT-FIFO');

    const segunda = await revertir(id);
    assert.equal(segunda.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal((await inversosDe(id)).length, 1, 'sigue habiendo un solo inverso');
  });

  test('el movimiento inverso no se puede revertir', async () => {
    const id = (await salidaDe(2)).body.movimiento_id;
    const r = await revertir(id);
    const stock = await db.stockDe('MAT-FIFO');

    const otra = await revertir(r.body.inverso_id);
    assert.equal(otra.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal((await inversosDe(r.body.inverso_id)).length, 0);
  });

  test('un consumo de OT no se revierte desde el historial: 400 y nada cambia', async () => {
    const c = await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1 } });
    assert.ok(c.status < 300, JSON.stringify(c.body));
    const [mov] = await movimiento('mi.orden_trabajo_id_orden = 1', []);
    const stock = await db.stockDe('MAT-FIFO');

    const r = await revertir(mov.id);
    assert.equal(r.status, 400);
    assert.match(r.body.error, /OT/);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal((await original(mov.id)).estado, 'completado');
  });

  test('tipo sin sentido definido, merma pendiente o rechazada: 400 y nada cambia', async () => {
    const { rows } = await db.query(
      `INSERT INTO inventario.movimiento_inventario (
         movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku, bodega_id_bodega,
         usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento)
       VALUES (1, 'completado', 'MAT-FIFO', 1, 1, 3),
              (1, 'pendiente_aprobacion', 'MAT-FIFO', 1, 1, 2),
              (1, 'rechazado', 'MAT-FIFO', 1, 1, 2)
       RETURNING movimiento_inventario_id_movimiento AS id`
    );
    const stock = await db.stockDe('MAT-FIFO');
    for (const { id } of rows) {
      assert.equal((await revertir(id)).status, 400, `movimiento ${id}`);
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal(await db.contar('inventario.movimiento_inventario', 'movimiento_inventario_id_revertido IS NOT NULL'), 0);
  });

  test('revertir una entrada ya consumida da 400 y no deja el movimiento marcado', async () => {
    // El caso que antes devolvía un 500 genérico por el CHECK de stock >= 0.
    const entrada = await api('POST', '/api/movimientos/entrada', {
      body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, numero_lote: 'LOTE-CONSUMIDO', ...compra() },
    });
    assert.equal(entrada.status, 201);

    // Se consume lo que entró, de modo que ya no hay qué devolver
    await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-UNO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    const r = await revertir(entrada.body.movimiento_id);
    assert.equal(r.status, 400);
    assert.match(JSON.stringify(r.body), /libres/i, 'el error debe explicar cuántas unidades quedan');
    assert.equal((await inversosDe(entrada.body.movimiento_id)).length, 0, 'un rechazo no crea el inverso');
    assert.equal(
      await db.contar('inventario.movimiento_inventario',
        'movimiento_inventario_id_movimiento = $1 AND movimiento_inventario_estado = $2',
        [entrada.body.movimiento_id, 'revertido']),
      0,
      'si la reversión falla, el movimiento NO puede quedar marcado como revertido'
    );
  });

  test('revertir un movimiento inexistente da 404', async () => {
    const r = await revertir(99999);
    assert.equal(r.status, 404);
  });
});

describe('Reporte de movimientos: montos por rol', () => {
  // Invariante: los montos se ocultan al rol JOP en el BACKEND, no solo en la vista.
  const rango = '?desde=2000-01-01&hasta=2100-12-31';

  test('JOP no recibe precio_unitario; gerencia si', async () => {
    await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 },
    });

    const jop = await api('GET', '/api/reportes/movimientos' + rango, { rol: 'jop' });
    const ger = await api('GET', '/api/reportes/movimientos' + rango);

    assert.equal(jop.status, 200);
    assert.equal(jop.body.movimientos.length, 1);
    assert.ok(!('precio_unitario' in jop.body.movimientos[0]), 'JOP no debe recibir el precio');
    assert.equal(parseFloat(ger.body.movimientos[0].precio_unitario), 1000);
  });
});

describe('Historial detallado (CU-31)', () => {
  const entrada = (extra = {}) => api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 1, ...compra(), ...extra },
  });
  const salida = (extra = {}) => api('POST', '/api/movimientos/salida', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 1, ...extra },
  });
  const historial = async (qs = '') => (await api('GET', '/api/movimientos?paginado=1' + qs)).body;

  test('Exc 3: fecha de inicio posterior a la de fin da 400', async () => {
    const r = await api('GET', '/api/movimientos?desde=2026-09-20&hasta=2026-09-10');
    assert.equal(r.status, 400);
  });

  test('con paginado=1 devuelve el total y la pagina pedida', async () => {
    for (let i = 0; i < 5; i++) await salida();

    const p1 = await historial('&limit=2&page=1');
    const p3 = await historial('&limit=2&page=3');

    assert.equal(p1.total, 5);
    assert.equal(p1.movimientos.length, 2);
    assert.equal(p3.movimientos.length, 1);
    const ids = new Set([...p1.movimientos, ...p3.movimientos].map(m => m.id));
    assert.equal(ids.size, 3, 'las paginas no se solapan');
  });

  test('CU-76: con exportar=1 trae todo lo filtrado (no la página de 50) y el total real', async () => {
    await db.query(
      `INSERT INTO inventario.movimiento_inventario (movimiento_inventario_cantidad, movimiento_inventario_estado,
         material_sku, bodega_id_bodega, usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento)
       SELECT 1, 'completado', 'MAT-FIFO', 1, 1, 2 FROM generate_series(1, 620)`
    );
    const pagina = await historial();
    assert.equal(pagina.movimientos.length, 50);

    const todo = await historial('&exportar=1&page=3&limit=5');   // page y limit se ignoran al exportar
    assert.equal(todo.movimientos.length, 620);
    assert.equal(todo.total, 620);

    const jop = await api('GET', '/api/movimientos?paginado=1&exportar=1', { rol: 'jop' });
    assert.equal(jop.status, 200);
    assert.equal(jop.body.movimientos.length, 620);
  });

  test('sin paginado sigue respondiendo un array', async () => {
    await salida();
    const r = await api('GET', '/api/movimientos');
    assert.ok(Array.isArray(r.body));
  });

  test('la bodega es origen en una salida y destino en una entrada', async () => {
    await entrada({ numero_lote: 'LOTE-CU31' });
    await salida();

    const { movimientos } = await historial();
    const ent = movimientos.find(m => m.tipo === 'entrada');
    const sal = movimientos.find(m => m.tipo === 'salida');

    assert.equal(ent.bodega_origen, null);
    assert.equal(ent.bodega_destino, 'Bodega Test');
    assert.equal(sal.bodega_origen, 'Bodega Test');
    assert.equal(sal.bodega_destino, null);
  });

  test('filtra por bodega y por estado', async () => {
    await entrada({ bodega_id: 2, numero_lote: 'LOTE-B2' });
    await salida();
    await salida();
    const [ultima] = (await historial('&bodega_id=1')).movimientos;
    const r = await revertir(ultima.id);

    // CU-44: la reversión agrega el movimiento inverso en la bodega 1
    assert.equal((await historial('&bodega_id=2')).total, 1);
    assert.equal((await historial('&bodega_id=1')).total, 3);
    assert.equal((await historial('&estado=revertido')).total, 1);
    assert.equal((await historial('&estado=activo')).total, 3);

    // El historial enlaza el original con su inverso, en los dos sentidos
    const { movimientos } = await historial('&bodega_id=1');
    const orig = movimientos.find(m => String(m.id) === String(ultima.id));
    const inv  = movimientos.find(m => String(m.id) === String(r.body.inverso_id));
    assert.equal(String(orig.revertido_por), String(r.body.inverso_id));
    assert.equal(String(inv.revierte_a), String(ultima.id));
  });

  test('documento asociado: factura en una entrada y OT en un consumo', async () => {
    await entrada({ numero_lote: 'LOTE-FACT', proveedor_id: 1, factura_numero: 'F-CU31-001', factura_fecha: '2026-09-01' });
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1 } });

    const { movimientos } = await historial();
    const ent = movimientos.find(m => m.tipo === 'entrada');
    const consumo = movimientos.find(m => m.orden_trabajo_id != null);

    assert.equal(ent.documento_tipo, 'factura');
    assert.equal(ent.documento_ref, 'F-CU31-001');
    assert.equal(consumo.documento_tipo, 'ot');
    assert.equal(consumo.documento_ref, '1');
  });
});

describe('Tipos de entrada: compra y devolución de obra (D66)', () => {
  const { consumoNeto } = require('../src/db/historico');
  const entrada = (body) => api('POST', '/api/movimientos/entrada', {
    body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 2, tipo_movimiento_id: 1, ...body },
  });

  test('una compra sin precio, sin fecha de pedido, sin factura o sin proveedor → 400 y no se mueve nada', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    for (const falta of ['precio_unitario', 'fecha_pedido', 'factura_numero', 'proveedor_id']) {
      const datos = compra();
      delete datos[falta];
      if (falta === 'factura_numero') delete datos.factura_fecha;   // la factura va completa o no va
      const r = await entrada(datos);
      assert.equal(r.status, 400, falta);
    }
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);
  });

  test('la compra queda con el motivo compra_proveedor', async () => {
    const r = await entrada(compra());
    const { rows } = await db.query(
      `SELECT mot.movimiento_inventario_motivo_movimiento_nombre AS m FROM inventario.movimiento_inventario mi
       JOIN inventario.movimiento_inventario_motivo_movimiento mot USING (movimiento_inventario_motivo_movimiento_id_motivo_movimiento)
       WHERE mi.movimiento_inventario_id_movimiento = $1`, [r.body.movimiento_id]);
    assert.equal(rows[0].m, 'compra_proveedor');
  });

  test('devolución de obra: exige descripción, no admite proveedor ni factura, y resta del consumo', async () => {
    assert.equal((await entrada({ tipo_entrada: 'devolucion' })).status, 400, 'sin descripción');
    assert.equal((await entrada({ tipo_entrada: 'devolucion', descripcion_motivo: 'Vuelve de obra', proveedor_id: 1 })).status, 400);

    await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 5, tipo_movimiento_id: 2, motivo_id: 2 },   // consumo
    });
    assert.equal((await consumoNeto(db)).get('MAT-FIFO'), 5);
    const r = await entrada({ tipo_entrada: 'devolucion', descripcion_motivo: 'Sobrante de la obra NV-A' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await consumoNeto(db)).get('MAT-FIFO'), 3, 'la devolución resta del consumo');
    assert.ok(!r.body.insumo_especial, 'no dispara la recepción de un insumo especial');
  });

  test('tipo de entrada desconocido → 400', async () => {
    assert.equal((await entrada({ ...compra(), tipo_entrada: 'regalo' })).status, 400);
  });
});
