const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Crear OT desde Inventario (F-06; D70, D71).
 *
 * Lo que se protege: la OT nace "pendiente" con su área, proyecto, receta, puertas y
 * responsable; cualquier dato inválido se rechaza sin crear nada; desde una venta se liga
 * al proyecto de Terreno de esa venta; y la OT nueva queda lista para el consumo (R1).
 *
 * Semilla: áreas 1 Corte, 2 Pintura, 3 Instalación; proyecto 1 (PRY-TEST); receta 1 (PB-TEST)
 * con MAT-FIFO y MAT-CRIT del área Corte; usuarios 1 gerencia y 2 jop. OTs 1 a 3 ya existen.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const crear = (body, rol) => api('POST', '/api/ordenes-trabajo', { body, rol });
const totalOT = () => db.contar('inventario.orden_trabajo');

async function otGuardada(id) {
  const { rows } = await db.query(
    `SELECT orden_trabajo_estado AS estado, area_trabajo_id_area::int AS area, proyecto_id_proyecto::int AS proyecto,
            producto_terminado_id_producto::int AS receta, orden_trabajo_cantidad_puertas AS puertas,
            usuario_id_usuario::int AS responsable
     FROM inventario.orden_trabajo WHERE orden_trabajo_id_orden = $1`, [id]);
  return rows[0];
}

/** Venta aprobada `id`; con proyecto financiero ligado al proyecto de Terreno `proyectoTerreno` (o sin él). */
async function venta(id, { estado = 'aprobada', proyectoTerreno = 1 } = {}) {
  await db.query(`INSERT INTO finanzas.tipo_cliente (id_tipo_cliente, nombre_tipo_cliente)
                  OVERRIDING SYSTEM VALUE VALUES (1, 'empresa') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO finanzas.cliente_financiero (id_cliente_financiero, rut_cliente, id_tipo_cliente, nombre_razon_social)
                  OVERRIDING SYSTEM VALUE VALUES (1, '11111111-1', 1, 'Cliente de prueba') ON CONFLICT DO NOTHING`);
  await db.query(`INSERT INTO finanzas.proyecto_financiero (id_proyecto_financiero, id_cliente_financiero, id_proyecto_terreno,
                    codigo_proyecto, fecha_ingreso)
                  OVERRIDING SYSTEM VALUE VALUES ($1, 1, $2, $3, CURRENT_DATE)`, [id, proyectoTerreno, 'PF-' + id]);
  await db.query(`INSERT INTO finanzas.nota_venta (id_nota_venta, numero_nota_venta, id_cliente_financiero,
                    id_proyecto_financiero, fecha_emision, estado_pedido)
                  OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, $1, CURRENT_DATE, $3)`, [id, 'NV-' + id, estado]);
}

describe('crear', () => {
  test('nace pendiente con área, proyecto, receta, puertas y responsable', async () => {
    const r = await crear({ area_id: 1, proyecto_id: 1, receta_id: 1, cantidad_puertas: 2, responsable_id: 2 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(await otGuardada(r.body.id),
      { estado: 'pendiente', area: 1, proyecto: 1, receta: 1, puertas: 2, responsable: 2 });
  });

  test('sin responsable, lo es quien la crea; sin receta ni proyecto también se puede', async () => {
    const r = await crear({ area_id: 2 }, 'jop');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ot = await otGuardada(r.body.id);
    assert.equal(ot.responsable, 2);
    assert.equal(ot.receta, null);
    assert.equal(ot.proyecto, null);
  });

  test('desde una venta aprobada toma su proyecto de Terreno', async () => {
    await venta(10);
    const r = await crear({ area_id: 1, nota_venta_id: 10 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal((await otGuardada(r.body.id)).proyecto, 1);
  });

  test('la OT nueva carga su receta en Consumo y acepta el consumo', async () => {
    const { body: { id } } = await crear({ area_id: 1, receta_id: 1, cantidad_puertas: 2 });

    const pre = await api('GET', `/api/recetas/por-orden/${id}`);
    assert.equal(pre.body.origen, 'ot');
    assert.deepEqual(Object.fromEntries(pre.body.materiales.map(m => [m.sku, m.cantidad_total])), { 'MAT-CRIT': 8, 'MAT-FIFO': 5 });

    const g = await api('PUT', `/api/ordenes-trabajo/${id}/consumo`, {
      body: { receta_id: 1, cantidad_puertas: 2, lineas: [{ sku: 'MAT-FIFO', estimado: 5, real: 5 }] },
    });
    assert.equal(g.status, 200, JSON.stringify(g.body));
    assert.deepEqual(await db.stockDe('MAT-FIFO'), { fisica: 25, reservada: 5 });
  });
});

describe('rechazos: no se crea nada', () => {
  const casos = [
    ['sin área', { proyecto_id: 1 }, /área/],
    ['área inexistente', { area_id: 99 }, /área no existe/],
    ['proyecto inexistente', { area_id: 1, proyecto_id: 99 }, /proyecto no existe/],
    ['receta sin insumos del área', { area_id: 2, receta_id: 1, cantidad_puertas: 1 }, /no tiene insumos del área Pintura/],
    ['puertas inválidas', { area_id: 1, receta_id: 1, cantidad_puertas: 0 }, /puertas/],
    ['responsable inexistente', { area_id: 1, responsable_id: 99 }, /responsable no existe/],
  ];
  for (const [nombre, body, mensaje] of casos) {
    test(nombre, async () => {
      const antes = await totalOT();
      const r = await crear(body);
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error, mensaje);
      assert.equal(await totalOT(), antes);
    });
  }

  test('área inactiva y responsable inactivo', async () => {
    await db.query(`UPDATE inventario.area_trabajo SET area_trabajo_activo = FALSE WHERE area_trabajo_id_area = 2`);
    await db.query(`UPDATE inventario.usuario SET usuario_estado_cuenta = 'inactivo' WHERE usuario_id_usuario = 3`);
    assert.match((await crear({ area_id: 2 })).body.error, /inactiva/);
    assert.match((await crear({ area_id: 1, responsable_id: 3 })).body.error, /no tiene la cuenta activa/);
  });

  test('venta pendiente, sin proyecto de Terreno o de otro proyecto', async () => {
    await venta(11, { estado: 'pendiente' });
    await venta(12, { proyectoTerreno: null });
    await venta(13);
    const antes = await totalOT();
    assert.match((await crear({ area_id: 1, nota_venta_id: 11 })).body.error, /no está aprobada/);
    assert.match((await crear({ area_id: 1, nota_venta_id: 12 })).body.error, /no tiene un proyecto de Terreno/);
    assert.match((await crear({ area_id: 1, nota_venta_id: 13, proyecto_id: 2 })).body.error, /otro proyecto/);
    assert.equal(await totalOT(), antes);
  });
});

test('gerencia y jop crean; técnico y secretaria no', async () => {
  assert.equal((await crear({ area_id: 1 }, 'gerencia')).status, 201);
  assert.equal((await crear({ area_id: 1 }, 'jop')).status, 201);
  assert.equal((await crear({ area_id: 1 }, 'tecnico')).status, 403);
  assert.equal((await crear({ area_id: 1 }, 'secretaria')).status, 403);
});

test('opciones del formulario: áreas activas, proyectos, ventas con su proyecto y usuarios activos', async () => {
  await venta(10);
  await venta(11, { estado: 'pendiente' });
  const r = await api('GET', '/api/ordenes-trabajo/opciones-nueva', { rol: 'jop' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.areas.map(a => a.nombre), ['Corte', 'Instalación', 'Pintura']);
  assert.deepEqual(r.body.proyectos.map(p => p.codigo), ['PRY-TEST']);
  assert.deepEqual(r.body.ventas.map(v => [v.numero, Number(v.proyecto_id)]), [['NV-10', 1]]);
  assert.equal(r.body.usuarios.length, 5);
});

// F-24: proyectos con sus OT, para crear una OT desde el proyecto
test('GET /proyectos: cada proyecto con sus OT abiertas, terminadas y anuladas; cualquier rol lo lee', async () => {
  // Semilla: proyecto 1 con OT 1 y 3 en curso y OT 2 finalizada. Se anula una nueva y se agrega un proyecto sin OT.
  const r1 = await crear({ area_id: 1, proyecto_id: 1 });
  assert.equal(r1.status, 201, JSON.stringify(r1.body));
  await db.query(`UPDATE inventario.orden_trabajo SET orden_trabajo_estado = 'cancelada' WHERE orden_trabajo_id_orden = $1`, [r1.body.id]);
  await db.query(`INSERT INTO terreno.proyecto (codigo_proyecto, nombre_referencia, fecha_instalacion, fecha_ingreso,
                    estado_operacional, estado_produccion, rut_cliente)
                  VALUES ('PRY-PRUEBA-OT-01', 'Proyecto de prueba', CURRENT_DATE, CURRENT_DATE, 'en_curso', 'en_proceso', '11111111-1')`);
  for (const rol of ['gerencia', 'jop', 'tecnico']) {
    const r = await api('GET', '/api/ordenes-trabajo/proyectos', { rol });
    assert.equal(r.status, 200, rol);
    assert.deepEqual(r.body.map(p => [p.codigo, p.ot_abiertas, p.ot_terminadas, p.ot_anuladas]),
      [['PRY-PRUEBA-OT-01', 0, 0, 0], ['PRY-TEST', 2, 1, 1]], rol);
  }
  assert.equal(await totalOT(), 4);   // solo lee
});
