const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { api, bajar, firmaGerencia } = require('./helpers/api');
const db = require('./helpers/db');
const { stockAFecha } = require('../src/db/historico');

/**
 * F-11 paso 1 (D72, D73): firma de gerencia en las acciones sensibles de stock y configuración.
 * F-11 paso 2: OT (responsable y anular), proveedores y precios, maestros, recetas, pedidos y usuarios.
 *
 * Lo que protegen:
 *  - Sin firma válida, cada ruta del paso 1 responde 428 { requiere_firma } y la BD queda igual.
 *  - La firma vale para UNA acción, UNA vez y por 5 minutos.
 *  - Firma un gerente (no necesariamente el de la sesión): un jop la pide, pero no puede firmar.
 *    Mismo bloqueo que CU-42 (3 fallos → 15 min), contado sobre el gerente.
 *  - FIRMAS_DESACTIVADAS apaga una acción sin tocar código.
 *  - Salida con fecha pasada: firma propia, máximo 14 días y nunca antes del último conteo
 *    confirmado de la bodega; stockAFecha la ubica en su fecha.
 *
 * Semilla: usuario 1 gerencia, 2 jop. MAT-FIFO con stock libre en la bodega 1. OT 2 finalizada.
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); delete process.env.FIRMAS_DESACTIVADAS; });
after(async () => { delete process.env.FIRMAS_DESACTIVADAS; await bajar(); await db.cerrar(); });

const CLAVE = 'clave-de-prueba';
let hash = null;
async function conContrasenas() {
  hash = hash || await bcrypt.hash(CLAVE, 4);
  await db.query(`INSERT INTO inventario.usuario_contrasena (usuario_id_usuario, usuario_contrasena) VALUES (1, $1), (2, $1)`, [hash]);
}

const SALIDA = { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1, tipo_movimiento_id: 2, motivo_id: 2 };
const dos = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DDTHH:mm' local de hoy + `dias`, a las `hora` (como el datetime-local del navegador). */
function fechaLocal(dias, hora = 10) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}T${dos(hora)}:00`;
}

// [método, ruta, cuerpo, acción] — todo el paso 1
const RUTAS = [
  ['POST', '/api/movimientos/entrada', { sku: 'MAT-FIFO', bodega_id: 1, cantidad: 1 }, 'movimiento_manual'],
  ['POST', '/api/movimientos/salida', SALIDA, 'movimiento_manual'],
  ['POST', '/api/movimientos/salida', { ...SALIDA, fecha: fechaLocal(-1) }, 'salida_fecha_pasada'],
  ['POST', '/api/movimientos/traslado', { sku: 'MAT-FIFO', bodega_id: 1, bodega_destino_id: 2, cantidad: 1 }, 'movimiento_manual'],
  ['POST', '/api/movimientos/vincular-ot', {}, 'corregir_consumo'],
  ['PUT', '/api/movimientos/1/aprobar-merma', {}, 'aprobar_merma'],
  ['PUT', '/api/movimientos/1/rechazar-merma', {}, 'aprobar_merma'],
  ['POST', '/api/conteos/1/procesar', {}, 'ajuste_conteo'],
  ['POST', '/api/conteos/1/ajustes', {}, 'ajuste_conteo'],
  ['PUT', '/api/ordenes-trabajo/2/correccion', { motivo: 'x' }, 'corregir_consumo'],
  ['POST', '/api/catalogos/areas', { nombre: 'Soldadura', clasificacion: 'produccion' }, 'catalogos'],
  ['PUT', '/api/catalogos/areas/1', { nombre: 'Corte 2' }, 'catalogos'],
  ['POST', '/api/catalogos/unidades', { nombre: 'galón' }, 'catalogos'],
  ['DELETE', '/api/catalogos/unidades/2', {}, 'catalogos'],
  ['POST', '/api/catalogos/motivos', { nombre: 'Rotura', clasificacion_id: 2 }, 'catalogos'],
  ['DELETE', '/api/catalogos/motivos/3', {}, 'catalogos'],
  ['POST', '/api/materiales/catalogos/clasificacion/general', { nombre: 'Nueva' }, 'catalogos'],
  ['PUT', '/api/conteos/tolerancias', { critico: { tolerancia_pct: 2, umbral_critico_pct: 6 } }, 'tolerancias'],
  ['PUT', '/api/materiales/MAT-FIFO', { stock_minimo: 7 }, 'umbrales_stock'],
  ['PUT', '/api/herramientas/MAT-HERR', { nombre: 'Otra' }, 'depreciacion'],
  ['PUT', '/api/herramientas/MAT-HERR/depreciacion', { vida_util_meses: 12 }, 'depreciacion'],
  ['POST', '/api/integracion/reglas', {}, 'reglas_integracion'],
  ['PUT', '/api/integracion/reglas', {}, 'reglas_integracion'],
  ['DELETE', '/api/integracion/reglas', {}, 'reglas_integracion'],
];

/** Una foto de lo que estas rutas podrían cambiar. */
async function foto() {
  const r = {};
  for (const t of ['movimiento_inventario', 'area_trabajo', 'material_unidad_medida', 'movimiento_inventario_motivo_movimiento',
                   'material_categoria_general', 'perfil_permiso', 'reautenticacion_intento']) {
    r[t] = await db.contar(`inventario.${t}`);
  }
  r.stock = await db.stockDe('MAT-FIFO');
  const q = async (sql) => (await db.query(sql)).rows;
  r.tolerancias = await q(`SELECT * FROM inventario.tolerancia_conteo ORDER BY 1`);
  r.material = await q(`SELECT material_stock_minimo, material_nombre_material FROM inventario.material ORDER BY material_sku`);
  r.areas = await q(`SELECT area_trabajo_nombre_area FROM inventario.area_trabajo ORDER BY 1`);
  return JSON.stringify(r);
}

describe('Sin firma válida no se hace nada', () => {
  test('cada ruta del paso 1 → 428 con su acción, y la BD queda igual', async () => {
    const antes = await foto();
    for (const [metodo, ruta, body, accion] of RUTAS) {
      const r = await api(metodo, ruta, { body, sinFirma: true });
      assert.equal(r.status, 428, `${metodo} ${ruta} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.requiere_firma, accion, `${metodo} ${ruta}`);
    }
    assert.equal(await foto(), antes);
  });

  test('firma de otra acción, vencida o ya usada → 428; válida → se registra', async () => {
    const salida = (firma) => api('POST', '/api/movimientos/salida', { body: SALIDA, firma, sinFirma: true });
    assert.equal((await salida(firmaGerencia('catalogos'))).status, 428);
    assert.equal((await salida(firmaGerencia('movimiento_manual', {}, { expiresIn: '-1s' }))).status, 428);
    assert.equal((await salida(firmaGerencia('movimiento_manual', { tipo: 'autorizacion' }))).status, 428);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);

    const firma = firmaGerencia('movimiento_manual');
    assert.equal((await salida(firma)).status, 201);
    const r = await salida(firma);
    assert.equal(r.status, 428);
    assert.match(r.body.error, /ya se usó/);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 1);
  });

  test('umbrales: solo cambiar el mínimo, máximo o crítico pide firma', async () => {
    assert.equal((await api('PUT', '/api/materiales/MAT-FIFO', { body: { nombre: 'Otro nombre' }, sinFirma: true })).status, 200);
    assert.equal((await api('PUT', '/api/materiales/MAT-FIFO', { body: { stock_minimo: 5 }, sinFirma: true })).status, 200, 'mismo valor');
    assert.equal((await api('PUT', '/api/materiales/MAT-FIFO', { body: { stock_critico: 1 }, sinFirma: true })).status, 428);
  });

  test('FIRMAS_DESACTIVADAS apaga una acción sin tocar las demás', async () => {
    process.env.FIRMAS_DESACTIVADAS = 'tolerancias, movimiento_manual';
    assert.equal((await api('POST', '/api/movimientos/salida', { body: SALIDA, sinFirma: true })).status, 201);
    assert.equal((await api('POST', '/api/catalogos/unidades', { body: { nombre: 'galón' }, sinFirma: true })).status, 428);
  });
});

describe('Firma de un gerente (POST /auth/reautenticar con usuario)', () => {
  const firmar = (body, rol) => api('POST', '/api/auth/reautenticar', { rol, body });

  test('un jop pide la firma de un gerente y con ella registra la salida', async () => {
    await conContrasenas();
    const f = await firmar({ username: 'gerente.test', password: CLAVE, accion: 'movimiento_manual' }, 'jop');
    assert.equal(f.status, 200, JSON.stringify(f.body));
    const r = await api('POST', '/api/movimientos/salida', { rol: 'jop', body: SALIDA, firma: f.body.autorizacion, sinFirma: true });
    assert.equal(r.status, 201);
    const { rows } = await db.query(`SELECT usuario_id_usuario::int AS u, reautenticacion_intento_accion AS a
                                     FROM inventario.reautenticacion_intento WHERE reautenticacion_intento_exitoso`);
    assert.deepEqual(rows, [{ u: 1, a: 'movimiento_manual' }]);
  });

  test('un jop no puede firmar; acción desconocida → 400', async () => {
    await conContrasenas();
    assert.equal((await firmar({ username: 'jop.test', password: CLAVE, accion: 'movimiento_manual' }, 'jop')).status, 403);
    assert.equal((await firmar({ username: 'gerente.test', password: CLAVE, accion: 'otra' }, 'jop')).status, 400);
    assert.equal(await db.contar('inventario.reautenticacion_intento'), 0);
  });

  test('contraseña incorrecta → 403 con intentos; al tercero → 423 y bloquea también la correcta', async () => {
    await conContrasenas();
    const mala = { username: 'gerente.test', password: 'otra', accion: 'tolerancias' };
    const r = await firmar(mala, 'jop');
    assert.equal(r.status, 403);
    assert.equal(r.body.intentos_restantes, 2);
    assert.equal((await firmar(mala, 'jop')).status, 403);
    assert.equal((await firmar(mala, 'jop')).status, 423);
    assert.equal((await firmar({ ...mala, password: CLAVE }, 'jop')).status, 423);
  });

  test('técnico no pide firmas', async () => {
    await conContrasenas();
    assert.equal((await firmar({ username: 'gerente.test', password: CLAVE, accion: 'movimiento_manual' }, 'tecnico')).status, 403);
  });
});

describe('Salida con fecha pasada (D73)', () => {
  const salida = (fecha, opciones = {}) => api('POST', '/api/movimientos/salida', { body: { ...SALIDA, fecha }, ...opciones });

  test('pide su propia firma: la del movimiento manual no sirve', async () => {
    const r = await salida(fechaLocal(-2), { firma: firmaGerencia('movimiento_manual'), sinFirma: true });
    assert.equal(r.status, 428);
    assert.equal(r.body.requiere_firma, 'salida_fecha_pasada');
  });

  test('más de 14 días, futura o inválida → 400 sin mover stock', async () => {
    const stock = await db.stockDe('MAT-FIFO');
    assert.equal((await salida(fechaLocal(-15))).status, 400);
    assert.equal((await salida(fechaLocal(1))).status, 400);
    assert.equal((await salida('ayer')).status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
  });

  test('no antes del último conteo confirmado de la bodega', async () => {
    await db.query(`INSERT INTO inventario.conteo_ciclico (conteo_ciclico_estado, conteo_ciclico_fecha_confirmacion,
                      bodega_id_bodega, usuario_id_usuario) VALUES ('confirmado', now() - interval '3 days', 1, 1)`);
    const stock = await db.stockDe('MAT-FIFO');
    assert.equal((await salida(fechaLocal(-4))).status, 400);
    assert.deepEqual(await db.stockDe('MAT-FIFO'), stock);
    assert.equal((await salida(fechaLocal(-2))).status, 201);
  });

  test('se guarda en su fecha y stockAFecha la ubica ahí', async () => {
    const fecha = fechaLocal(-3, 10);
    const r = await salida(fecha);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const { rows } = await db.query(`SELECT movimiento_inventario_fecha_hora AS f FROM inventario.movimiento_inventario`);
    assert.equal(new Date(rows[0].f).getTime(), new Date(fecha).getTime());

    const despues = (await stockAFecha(db, new Date(new Date(fecha).getTime() + 60000))).get('MAT-FIFO');
    const antes = (await stockAFecha(db, new Date(new Date(fecha).getTime() - 60000))).get('MAT-FIFO');
    assert.equal(antes - despues, 1);
  });

  test('una fecha de hoy no es pasada: firma de movimiento manual y hora actual', async () => {
    const r = await salida(fechaLocal(0, 0), { firma: firmaGerencia('movimiento_manual'), sinFirma: true });
    assert.equal(r.status, 201);
  });
});

/* ── Paso 2 ───────────────────────────────────────────────────────────── */

// [método, ruta, cuerpo, acción]. Semilla: OT 1 abierta (responsable 2), proveedores 1 y 2, bodegas
// 1 y 2, anaquel 1, receta 1, usuarios 1-5.
const RUTAS_PASO2 = [
  ['PUT', '/api/ordenes-trabajo/1/responsable', { responsable_id: 5 }, 'ot_responsable'],
  ['POST', '/api/usuarios/2/reasignar-ot', { responsable_id: 5 }, 'ot_responsable'],
  ['PUT', '/api/ordenes-trabajo/1/anular', { motivo: 'Creada por error' }, 'ot_anular'],
  ['POST', '/api/materiales/MAT-FIFO/proveedores', { proveedor_id: 2, precio: 100 }, 'precio_proveedor'],
  ['PUT', '/api/proveedores/1', { razon_social: 'Otro nombre' }, 'precio_proveedor'],
  ['PUT', '/api/proveedores/2/estado', { estado: 'inactivo' }, 'precio_proveedor'],
  ['DELETE', '/api/proveedores/2', {}, 'precio_proveedor'],
  ['DELETE', '/api/materiales/MAT-FIFO', {}, 'eliminar_maestro'],
  ['PUT', '/api/materiales/MAT-FIFO/reactivar', {}, 'eliminar_maestro'],
  ['DELETE', '/api/bodegas/2', {}, 'eliminar_maestro'],
  ['DELETE', '/api/bodegas/1/anaqueles/1', {}, 'eliminar_maestro'],
  ['PUT', '/api/recetas/1/estado', { activo: false }, 'receta_vigente'],
  ['PUT', '/api/pedidos-venta/1/cancelar', {}, 'pedido_cancelar'],
  ['PUT', '/api/pedidos-venta/1/deshacer-preparado', {}, 'pedido_cancelar'],
  ['POST', '/api/usuarios', { username: 'nuevo.usuario', rol: 'jop' }, 'usuarios'],
  ['PUT', '/api/usuarios/2/permisos', { rol: 'tecnico' }, 'usuarios'],
  ['POST', '/api/usuarios/2/recuperar-password', {}, 'usuarios'],
  ['POST', '/api/usuarios/2/programar-desactivacion', { fecha: fechaLocal(1) }, 'usuarios'],
  ['POST', '/api/usuarios/2/programar-activacion', { fecha: fechaLocal(1) }, 'usuarios'],
  ['DELETE', '/api/usuarios/2/programacion', {}, 'usuarios'],
];

/** Una foto de lo que las rutas del paso 2 podrían cambiar. */
async function fotoPaso2() {
  const r = {};
  for (const t of ['orden_trabajo', 'proveedor', 'material_proveedor', 'material', 'bodega', 'anaquel', 'producto_terminado',
                   'material_producto_terminado', 'usuario', 'usuario_contrasena', 'reserva_inventario', 'preparacion_pedido']) {
    r[t] = (await db.query(`SELECT * FROM inventario.${t} ORDER BY 1`)).rows;
  }
  return JSON.stringify(r);
}

describe('Paso 2: sin firma válida no se hace nada', () => {
  test('cada ruta del paso 2 → 428 con su acción, y la BD queda igual', async () => {
    const antes = await fotoPaso2();
    for (const [metodo, ruta, body, accion] of RUTAS_PASO2) {
      const r = await api(metodo, ruta, { body, sinFirma: true });
      assert.equal(r.status, 428, `${metodo} ${ruta} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.requiere_firma, accion, `${metodo} ${ruta}`);
    }
    assert.equal(await fotoPaso2(), antes);
  });

  test('con la firma de su acción pasa; la de otra acción no sirve', async () => {
    const responsable = (firma) => api('PUT', '/api/ordenes-trabajo/1/responsable', { body: { responsable_id: 5 }, firma, sinFirma: true });
    assert.equal((await responsable(firmaGerencia('usuarios'))).status, 428);
    const r = await responsable(firmaGerencia('ot_responsable'));
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const estado = await api('PUT', '/api/recetas/1/estado', { body: { activo: false }, firma: firmaGerencia('receta_vigente'), sinFirma: true });
    assert.equal(estado.status, 200, JSON.stringify(estado.body));
  });

  test('receta: dentro de las 24 h se edita sin firma; después pide la firma, y el motivo va antes', async () => {
    const nueva = { materiales: [{ sku: 'MAT-UNO', cantidad_base: 3, area_id: 1 }] };
    const editar = (body, opciones = {}) => api('PUT', '/api/recetas/1', { body, sinFirma: true, ...opciones });
    assert.equal((await editar(nueva)).status, 200, 'en plazo');

    await db.query(`UPDATE inventario.producto_terminado SET producto_terminado_fecha_creacion = now() - interval '25 hours'
                    WHERE producto_terminado_id_producto = 1`);
    const antes = await fotoPaso2();
    assert.equal((await editar(nueva)).status, 400, 'sin motivo: 400 antes de pedir la firma');
    const r = await editar({ ...nueva, motivo: 'Corrige cantidad' });
    assert.equal(r.status, 428);
    assert.equal(r.body.requiere_firma, 'receta_vigente');
    assert.equal(await fotoPaso2(), antes);
    assert.equal((await editar({ ...nueva, motivo: 'Corrige cantidad' }, { firma: firmaGerencia('receta_vigente') })).status, 200);
  });

  test('procesar las programaciones de cuentas no pide firma (la llama el sistema)', async () => {
    const r = await api('POST', '/api/usuarios/procesar-programaciones', { sinFirma: true });
    assert.notEqual(r.status, 428);
  });

  test('un jop pide la firma para anular una OT; el rol se revisa antes que la firma', async () => {
    const r = await api('PUT', '/api/ordenes-trabajo/1/anular', { rol: 'jop', body: { motivo: 'Creada por error' }, sinFirma: true });
    assert.equal(r.status, 428);
    assert.equal(r.body.requiere_firma, 'ot_anular');
    assert.equal((await api('PUT', '/api/proveedores/1', { rol: 'jop', body: { razon_social: 'x' }, sinFirma: true })).status, 403);
    assert.equal((await api('POST', '/api/usuarios', { rol: 'jop', body: {}, sinFirma: true })).status, 403);
  });
});

/* ── B-22: la firma solo se gasta con un éxito ───────────────────────── */

describe('B-22: un rechazo no gasta la firma', () => {
  const salida = (body, firma) => api('POST', '/api/movimientos/salida', { body, firma, sinFirma: true });

  test('error de validación (400): la misma firma sirve al corregir; tras el éxito ya no', async () => {
    const firma = firmaGerencia('movimiento_manual');
    const mala = await salida({ ...SALIDA, cantidad: 0 }, firma);
    assert.equal(mala.status, 400, JSON.stringify(mala.body));
    assert.equal(await db.contar('inventario.movimiento_inventario'), 0);

    assert.equal((await salida(SALIDA, firma)).status, 201, 'la firma sigue valiendo para el reintento');
    const otra = await salida(SALIDA, firma);
    assert.equal(otra.status, 428);
    assert.match(otra.body.error, /ya se usó/);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 1);
  });

  test('conflicto (409): la firma tampoco se gasta', async () => {
    const firma = firmaGerencia('catalogos');
    const crear = (nombre) => api('POST', '/api/catalogos/unidades', { body: { nombre }, firma, sinFirma: true });
    assert.equal((await crear('litro')).status, 409, 'la unidad ya existe');
    assert.equal((await crear('galón')).status, 201);
  });

  test('dos peticiones simultáneas con la misma firma: pasa solo una', async () => {
    const firma = firmaGerencia('movimiento_manual');
    const r = await Promise.all([salida(SALIDA, firma), salida(SALIDA, firma)]);
    assert.deepEqual(r.map(x => x.status).sort(), [201, 428]);
    assert.equal(await db.contar('inventario.movimiento_inventario'), 1);
  });
});
