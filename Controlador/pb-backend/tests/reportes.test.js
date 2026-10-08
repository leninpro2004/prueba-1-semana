const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * Reportes de Movimientos y de Mermas (pendientes de la sesión 2, cerrados en CU-75).
 *
 * Lo que protegen:
 *  - los KPIs cuentan solo movimientos vigentes: sin revertidos ni sus inversos
 *    (D23), sin mermas pendientes ni rechazadas; los excluidos se listan igual
 *  - "Traslados" = salidas con clasificación Traslado
 *  - Mermas usa el MISMO criterio de merma que la salida (pérdida, perdida, merma),
 *    no lista revertidas ni rechazadas y no suma las pendientes
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

/** Movimiento directo en BD, de ayer (no mueve stock). */
async function movimiento({ sku = 'MAT-FIFO', tipo = 2, cantidad = 1, estado = 'completado', motivo = null, revierte = null }) {
  const { rows } = await db.query(
    `INSERT INTO inventario.movimiento_inventario (
       movimiento_inventario_cantidad, movimiento_inventario_estado, material_sku, bodega_id_bodega,
       usuario_id_usuario, movimiento_inventario_tipo_movimiento_id_tipo_movimiento,
       movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_id_revertido,
       movimiento_inventario_fecha_hora)
     VALUES ($1, $2, $3, 1, 1, $4, $5, $6, now() - INTERVAL '1 day')
     RETURNING movimiento_inventario_id_movimiento AS id`,
    [cantidad, estado, sku, tipo, motivo, revierte]
  );
  return rows[0].id;
}

/** Clasificación y motivo extra (ids 9 en adelante, fuera de la semilla). */
async function motivoCon(id, clasificacion, motivo) {
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_clasificacion_salida
       (movimiento_inventario_clasificacion_salida_id_clasificacion_sal, movimiento_inventario_clasificacion_salida_nombre)
     OVERRIDING SYSTEM VALUE VALUES ($1, $2)`, [id, clasificacion]
  );
  await db.query(
    `INSERT INTO inventario.movimiento_inventario_motivo_movimiento
       (movimiento_inventario_motivo_movimiento_id_motivo_movimiento, movimiento_inventario_motivo_movimiento_nombre,
        movimiento_inventario_clasificacion_salida_id_clasificacion_sal)
     OVERRIDING SYSTEM VALUE VALUES ($1, $2, $1)`, [id, motivo]
  );
}

function hoyMas(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const periodo = `desde=${hoyMas(-7)}&hasta=${hoyMas(0)}`;

describe('Reporte de Movimientos: KPIs solo con vigentes', () => {
  test('anulados, inversos, pendientes y rechazados se listan pero no cuentan; traslados sí', async () => {
    await motivoCon(9, 'Traslado', 'traslado_bodega');
    await movimiento({ tipo: 1, cantidad: 10 });                              // entrada vigente
    await movimiento({ cantidad: 2, motivo: 2 });                             // salida vigente
    await movimiento({ cantidad: 3, motivo: 9 });                             // traslado
    const original = await movimiento({ cantidad: 4, estado: 'revertido' });
    await movimiento({ tipo: 1, cantidad: 4, revierte: original });           // su inverso
    await movimiento({ sku: 'MAT-CRIT', cantidad: 1, motivo: 3, estado: 'pendiente_aprobacion' });
    await movimiento({ sku: 'MAT-CRIT', cantidad: 1, motivo: 3, estado: 'rechazado' });

    const r = await api('GET', `/api/reportes/movimientos?${periodo}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.movimientos.length, 7, 'la tabla muestra todos, con su estado');
    assert.deepEqual(
      { ...r.body.resumen },
      { total_movimientos: 3, total_entradas: 1, total_salidas: 2, total_traslados: 1, con_orden_trabajo: 0, excluidos: 4 }
    );
    const inverso = r.body.movimientos.find(m => m.revierte_a != null);
    assert.equal(String(inverso.revierte_a), String(original));
  });
});

describe('Reporte de Mermas', () => {
  test('reconoce "perdida" y "merma" como la salida; sin revertidas ni rechazadas; pendientes fuera de los totales', async () => {
    await motivoCon(9, 'merma', 'merma_proceso');
    await movimiento({ cantidad: 2, motivo: 3 });                                        // clasificación "perdida"
    await movimiento({ cantidad: 3, motivo: 9 });                                        // clasificación "merma"
    await movimiento({ sku: 'MAT-CRIT', cantidad: 1, motivo: 3, estado: 'pendiente_aprobacion' });
    await movimiento({ cantidad: 5, motivo: 3, estado: 'revertido' });
    await movimiento({ cantidad: 4, motivo: 3, estado: 'rechazado' });
    await movimiento({ cantidad: 7, motivo: 2 });                                        // consumo: no es merma

    const r = await api('GET', `/api/reportes/mermas?${periodo}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.mermas.map(m => m.estado).sort(), ['completado', 'completado', 'pendiente_aprobacion']);
    assert.equal(r.body.resumen.total_eventos, 2);
    assert.equal(r.body.resumen.total_unidades, 5);
    assert.equal(r.body.resumen.valor_total_merma, 5 * 1000, 'MAT-FIFO a 1000; la pendiente de MAT-CRIT no suma');
    assert.equal(r.body.resumen.pendientes, 1);
    assert.equal(r.body.resumen.unidades_pendientes, 1);
  });

  test('el filtro de motivo acota por el nombre del catálogo', async () => {
    await motivoCon(9, 'merma', 'merma_proceso');
    await movimiento({ cantidad: 2, motivo: 3 });
    await movimiento({ cantidad: 3, motivo: 9 });

    const r = await api('GET', `/api/reportes/mermas?${periodo}&motivo=merma_proceso`);
    assert.deepEqual(r.body.mermas.map(m => m.motivo), ['merma_proceso']);
  });

  test('jop no recibe montos', async () => {
    await movimiento({ cantidad: 2, motivo: 3 });
    const r = await api('GET', `/api/reportes/mermas?${periodo}`, { rol: 'jop' });
    assert.equal(r.body.mermas[0].precio_unitario, undefined);
    assert.equal(r.body.resumen.valor_total_merma, undefined);
  });
});

describe('CSV de Programación (CU-76)', () => {
  const exportar = (semana) => api('GET', `/api/reportes/programacion-semanal/exportar?rango=1s&semana_inicio=${semana}`);

  test("separa con ';', fecha dd/mm/aaaa y el nombre del proyecto llega completo", async () => {
    await db.query(`UPDATE terreno.proyecto SET nombre_referencia = 'Edificio Los Robles, torre B; "norte"' WHERE id_proyecto = 1`);

    const r = await exportar('2026-12-01');   // instalación del proyecto 1: OT 1 y OT 3 abiertas
    assert.equal(r.status, 200);
    const lineas = String(r.body).replace(/^﻿/, '').split('\r\n');
    assert.equal(lineas[0], 'OT;Fecha instalación;Estado;Código Proyecto;Nombre Proyecto;Área;Responsable;Empleado tentativo');
    assert.equal(lineas.length, 3);
    assert.ok(lineas[1].includes(';01/12/2026;'), lineas[1]);
    assert.ok(lineas[1].includes('"Edificio Los Robles, torre B; ""norte"""'), lineas[1]);
  });

  test('sin OTs en el rango: 400 con "no hay datos"', async () => {
    const r = await exportar('2020-01-06');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /no hay datos/i);
  });
});
