const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');
const { consumoNeto } = require('../src/db/historico');

/**
 * Consumos de OT y reservas.
 *
 * Estas son las dos operaciones que más veces se rompieron durante el proyecto
 * (OPUS-1, OPUS-3, OPUS-4). Los tests apuntan a los invariantes que costó
 * conseguir, no a los mensajes.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Consumo real que la OT tiene registrado para un material. */
async function consumoReal(otId, sku) {
  const { rows } = await db.query(
    `SELECT material_orden_trabajo_consumo_real AS real
     FROM inventario.material_orden_trabajo
     WHERE orden_trabajo_id_orden = $1 AND material_sku = $2`,
    [otId, sku]
  );
  return rows.length && rows[0].real != null ? parseFloat(rows[0].real) : null;
}

describe('Registrar consumo en una OT', () => {
  test('descuenta el stock y deja el consumo registrado', async () => {
    const antes = await db.stockDe('MAT-FIFO');

    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 6, bodega_id: 1 },
    });

    assert.equal(r.status, 201);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica - 6);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 6);
  });

  test('genera un movimiento de salida vinculado a la OT', async () => {
    // OPUS-9 (Req #1): el movimiento tiene que quedar atado a la orden.
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 },
    });

    assert.equal(await db.contar('inventario.movimiento_inventario', 'orden_trabajo_id_orden = 1'), 1);
  });

  test('el movimiento hereda al responsable de la OT, no a quien lo registra', async () => {
    // La OT 1 tiene como responsable al usuario 2 (jop.test). Lo registra el 1.
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      rol: 'gerencia',
      body: { sku: 'MAT-FIFO', cantidad: 2, bodega_id: 1 },
    });

    const { rows } = await db.query(
      `SELECT usuario_id_usuario AS usuario, movimiento_inventario_descripcion_motivo AS nota
       FROM inventario.movimiento_inventario WHERE orden_trabajo_id_orden = 1`
    );
    assert.equal(rows.length, 1);
    assert.equal(parseInt(rows[0].usuario), 2, 'el movimiento es del responsable de la OT');
    assert.match(rows[0].nota, /Registrado por/, 'y deja constancia de quién lo registró');
  });

  test('stock insuficiente: rechaza sin tocar nada', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 999, bodega_id: 1 },
    });

    assert.equal(r.status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), antes);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), null);
  });

  test('un segundo consumo sin modo da 409 y NO descuenta stock', async () => {
    // El bug de OPUS-1: el 409 se devolvía DESPUÉS del descuento FIFO, así que
    // quedaba stock descontado sin consumo registrado.
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 5, bodega_id: 1 },
    });
    const trasPrimero = await db.stockDe('MAT-FIFO');

    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 },
    });

    assert.equal(r.status, 409);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), trasPrimero, 'el conflicto no puede mover stock');
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 5);
  });

  test("modo 'sumar' acumula y descuenta solo lo nuevo", async () => {
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 5, bodega_id: 1 } });
    const trasPrimero = await db.stockDe('MAT-FIFO');

    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1, modo: 'sumar' },
    });

    assert.equal(r.status, 201);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 8);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, trasPrimero.fisica - 3);
  });

  test("modo 'actualizar' a la BAJA devuelve stock en vez de descontar", async () => {
    // El otro bug de OPUS-1: 'actualizar' descontaba la cantidad completa otra
    // vez, en lugar de mover el stock por la diferencia.
    const antes = await db.stockDe('MAT-FIFO');
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 8, bodega_id: 1 } });

    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1, modo: 'actualizar' },
    });

    assert.equal(r.status, 201);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 3);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica - 3,
      'el stock debe reflejar SOLO el consumo final, no 8 + 3');
  });

  test('no se pueden registrar consumos en una OT cerrada', async () => {
    const r = await api('POST', '/api/ordenes-trabajo/2/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 1, bodega_id: 1 },
    });
    assert.equal(r.status, 400);
  });

  test('SKU inexistente da 404', async () => {
    const r = await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'NO-EXISTE', cantidad: 1, bodega_id: 1 },
    });
    assert.equal(r.status, 404);
  });
});

describe('Corregir y eliminar consumos', () => {
  test('editar a la alza descuenta solo la diferencia', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 4, bodega_id: 1 } });

    const r = await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 7 } });

    assert.equal(r.status, 200);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 7);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica - 7);
  });

  test('editar a la baja devuelve la diferencia al inventario', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 9, bodega_id: 1 } });

    const r = await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 2 } });

    assert.equal(r.status, 200);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica - 2);
  });

  test('la devolución por corrección lleva el motivo devolucion_consumo y resta del consumo', async () => {
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 9, bodega_id: 1 } });
    await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 2 } });

    const { rows } = await db.query(
      `SELECT mot.movimiento_inventario_motivo_movimiento_nombre AS motivo
       FROM inventario.movimiento_inventario mi
       JOIN inventario.movimiento_inventario_tipo_movimiento tm
         ON tm.movimiento_inventario_tipo_movimiento_id_tipo_movimiento = mi.movimiento_inventario_tipo_movimiento_id_tipo_movimiento
       LEFT JOIN inventario.movimiento_inventario_motivo_movimiento mot
         ON mot.movimiento_inventario_motivo_movimiento_id_motivo_movimiento = mi.movimiento_inventario_motivo_movimiento_id_motivo_movimiento
       WHERE mi.orden_trabajo_id_orden = 1 AND tm.movimiento_inventario_tipo_movimiento_nombre = 'entrada'`
    );
    assert.deepEqual(rows.map(r => r.motivo), ['devolucion_consumo']);
    assert.equal((await consumoNeto(db)).get('MAT-FIFO'), 2, '9 consumidos − 7 devueltos');
  });

  test('sin el motivo devolucion_consumo en el catálogo, la corrección a la baja se rechaza sin mover stock', async () => {
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 9, bodega_id: 1 } });
    const antes = await db.stockDe('MAT-FIFO');
    await db.query(`DELETE FROM inventario.movimiento_inventario_motivo_movimiento
                    WHERE movimiento_inventario_motivo_movimiento_nombre = 'devolucion_consumo'`);

    const r = await api('PUT', '/api/ordenes-trabajo/1/consumos/MAT-FIFO', { body: { cantidad: 2 } });

    assert.equal(r.status, 500);
    assert.match(r.body.error, /devolucion_consumo/);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica);
    assert.equal(await consumoReal(1, 'MAT-FIFO'), 9);
  });

  test('eliminar el material devuelve todo el stock consumido', async () => {
    const antes = await db.stockDe('MAT-FIFO');
    await api('POST', '/api/ordenes-trabajo/1/consumos', { body: { sku: 'MAT-FIFO', cantidad: 6, bodega_id: 1 } });

    const r = await api('DELETE', '/api/ordenes-trabajo/1/materiales/MAT-FIFO');

    assert.equal(r.status, 200);
    assert.equal((await db.stockDe('MAT-FIFO')).fisica, antes.fisica, 'el stock vuelve al punto de partida');
    assert.equal(await consumoReal(1, 'MAT-FIFO'), null);
  });
});

describe('Estimados de OT', () => {
  test('un lote con un SKU inexistente no guarda NADA', async () => {
    // El bug de OPUS-4: el FK violation a mitad del loop, sin transacción,
    // dejaba guardados los materiales anteriores y perdía los siguientes.
    const r = await api('PUT', '/api/ordenes-trabajo/1/estimados', {
      body: {
        materiales: [
          { sku: 'MAT-FIFO', cantidad_estimada: 99 },
          { sku: 'NO-EXISTE', cantidad_estimada: 5 },
          { sku: 'MAT-CRIT', cantidad_estimada: 77 },
        ],
      },
    });

    assert.equal(r.status, 400);
    const { rows } = await db.query(
      `SELECT material_orden_trabajo_consumo_estimado AS est FROM inventario.material_orden_trabajo
       WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-FIFO'`
    );
    assert.equal(parseFloat(rows[0].est), 12, 'el estimado original no debe haber cambiado');
  });

  test('un lote válido guarda todos los materiales', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/1/estimados', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad_estimada: 20 }, { sku: 'MAT-CRIT', cantidad_estimada: 6 }] },
    });
    assert.equal(r.status, 200);
  });
});

describe('Reservas', () => {
  /** El invariante que debe cumplirse después de CUALQUIER operación de reserva. */
  async function invarianteOk(mensaje) {
    const descuadres = await db.descuadresDeReservas();
    assert.deepEqual(descuadres, [], mensaje || 'reservas activas y stock reservado deben coincidir');
  }

  test('la semilla ya cumple el invariante', async () => {
    // Control: si esto falla, el problema está en el fixture y TODOS los demás
    // tests de reservas dejan de ser fiables.
    await invarianteOk('la semilla debe nacer cuadrada');
  });

  test('reservar aparta el stock y mantiene el invariante', async () => {
    const antes = await db.stockDe('MAT-CRIT');

    const r = await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 3 }] },
    });

    assert.equal(r.status, 200);
    const despues = await db.stockDe('MAT-CRIT');
    assert.equal(despues.reservada, antes.reservada + 3);
    assert.equal(despues.fisica, antes.fisica, 'reservar NO mueve stock físico');
    await invarianteOk();
  });

  test('la reserva guarda el proyecto de la OT', async () => {
    // Bug encontrado en OPUS-3: el proyecto quedaba siempre en NULL.
    await api('POST', '/api/pedidos/1/reservar', { body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 2 }] } });

    const { rows } = await db.query(
      `SELECT proyecto_id_proyecto AS proyecto FROM inventario.reserva_inventario
       WHERE orden_trabajo_id_orden = 1 AND material_sku = 'MAT-CRIT'`
    );
    assert.equal(parseInt(rows[0].proyecto), 1);
  });

  test('no se puede reservar más de lo disponible', async () => {
    const antes = await db.stockDe('MAT-CRIT');
    const r = await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 999 }] },
    });

    assert.notEqual(r.status, 200);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), antes);
  });

  test('liberar devuelve el stock reservado y mantiene el invariante', async () => {
    const antes = await db.stockDe('MAT-CRIT');
    const reserva = await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 4 }] },
    });
    const id = reserva.body.resultados[0].id;

    const r = await api('PUT', `/api/reservas/${id}/liberar`);

    assert.equal(r.status, 200);
    assert.deepEqual(await db.stockDe('MAT-CRIT'), antes, 'el stock vuelve a su estado original');
    await invarianteOk();
  });

  test('no se puede liberar dos veces', async () => {
    const reserva = await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 2 }] },
    });
    const id = reserva.body.resultados[0].id;
    await api('PUT', `/api/reservas/${id}/liberar`);

    const segunda = await api('PUT', `/api/reservas/${id}/liberar`);
    assert.equal(segunda.status, 400);
    await invarianteOk('liberar dos veces no debe descuadrar el stock');
  });

  test('reservar en una OT inexistente da 404', async () => {
    const r = await api('POST', '/api/pedidos/9999/reservar', {
      body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 1 }] },
    });
    assert.equal(r.status, 404);
  });

  test('el stock reservado no se puede consumir en una salida', async () => {
    await api('POST', '/api/pedidos/1/reservar', { body: { materiales: [{ sku: 'MAT-CRIT', cantidad: 6 }] } });

    // Quedan 8 físicas con 6 reservadas: solo 2 disponibles
    const r = await api('POST', '/api/movimientos/salida', {
      body: { sku: 'MAT-CRIT', bodega_id: 1, cantidad: 3, tipo_movimiento_id: 2, motivo_id: 2 },
    });
    assert.equal(r.status, 400);
  });
});

describe('Aviso de reservas ya consumidas', () => {
  /* El consumo NO libera la reserva: es un paso manual. El listado marca `cumplida`
     para que ese stock retenido no quede invisible (C+B del 2026-09-20). */

  test('una reserva cuyo consumo todavía no la alcanza no se marca', async () => {
    await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad: 4 }] },
    });
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 2, bodega_id: 1 },
    });

    const r = await api('GET', '/api/reservas?estado=activa');
    const nueva = r.body.find(x => x.sku === 'MAT-FIFO' && parseFloat(x.cantidad) === 4);

    assert.equal(nueva.cumplida, false);
  });

  test('cuando el consumo alcanza lo apartado, la reserva queda marcada', async () => {
    await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad: 3 }] },
    });
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 },
    });

    const r = await api('GET', '/api/reservas?estado=activa');
    const nueva = r.body.find(x => x.sku === 'MAT-FIFO' && parseFloat(x.cantidad) === 3);

    assert.equal(nueva.cumplida, true);
    assert.equal(parseFloat(nueva.consumo_real), 3);
  });

  test('consumir NO libera la reserva por su cuenta', async () => {
    const antes = await db.stockDe('MAT-FIFO');

    await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad: 3 }] },
    });
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 },
    });

    // el stock reservado sigue arriba: el consumo baja la física, no el apartado
    const despues = await db.stockDe('MAT-FIFO');
    assert.equal(despues.reservada, antes.reservada + 3);
    assert.equal(despues.fisica, antes.fisica - 3);
  });

  test('una reserva ya liberada no se marca como pendiente', async () => {
    await api('POST', '/api/pedidos/1/reservar', {
      body: { materiales: [{ sku: 'MAT-FIFO', cantidad: 3 }] },
    });
    await api('POST', '/api/ordenes-trabajo/1/consumos', {
      body: { sku: 'MAT-FIFO', cantidad: 3, bodega_id: 1 },
    });

    const { rows } = await db.query(
      `SELECT reserva_inventario_id_reserva AS id FROM inventario.reserva_inventario
       WHERE material_sku = 'MAT-FIFO' AND reserva_inventario_cantidad_reservada = 3
       ORDER BY 1 DESC LIMIT 1`
    );
    await api('PUT', `/api/reservas/${rows[0].id}/liberar`);

    const r = await api('GET', '/api/reservas');
    const liberada = r.body.find(x => x.id === rows[0].id);
    assert.equal(liberada.estado, 'liberada');
    assert.equal(liberada.cumplida, false);
    assert.equal((await db.descuadresDeReservas()).length, 0);
  });
});
