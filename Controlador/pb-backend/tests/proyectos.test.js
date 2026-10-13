const { test, before, after, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { api, bajar } = require('./helpers/api');
const db = require('./helpers/db');

/**
 * F-29 (D83): gerencia crea proyectos (y su cliente, si es nuevo) en terreno, temporalmente.
 *
 * Lo que se protege: el proyecto y el cliente nuevo se crean juntos o no se crea nada; el código
 * no se repite; un rechazo no escribe en terreno; solo gerencia crea.
 *
 * Semilla: cliente 11111111-1 y proyecto 1 (PRY-TEST).
 */

before(async () => { await db.resetear(); });
beforeEach(async () => { await db.resetear(); });
after(async () => { await bajar(); await db.cerrar(); });

const BASE = '/api/ordenes-trabajo/proyectos';
const crear = (body, rol) => api('POST', BASE, { body, rol });
const proyectos = () => db.contar('terreno.proyecto');
const clientes = () => db.contar('terreno.cliente');
const CLIENTE_NUEVO = { rut: '76.999.999-k', razon_social: 'Constructora Nueva SpA', contacto: 'Ana Pérez',
                        correo: 'ana@nueva.test', telefono: '+56 9 1234 5678', es_empresa: true };

describe('crear', () => {
  test('con un cliente existente: el proyecto queda en terreno y aparece en la lista', async () => {
    const r = await crear({ codigo: 'pry-2026-001', nombre: 'Edificio Central', fecha_instalacion: '2026-12-15', rut_cliente: '11111111-1' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.codigo, 'PRY-2026-001');
    const { rows } = await db.query(
      `SELECT nombre_referencia, to_char(fecha_instalacion, 'YYYY-MM-DD') AS f, rut_cliente, estado_operacional
       FROM terreno.proyecto WHERE id_proyecto = $1`, [r.body.id]);
    assert.deepEqual(rows[0], { nombre_referencia: 'Edificio Central', f: '2026-12-15', rut_cliente: '11111111-1', estado_operacional: 'en_curso' });
    const lista = await api('GET', BASE);
    assert.ok(lista.body.some(p => p.codigo === 'PRY-2026-001'));
  });

  test('con un cliente nuevo: crea los dos, con el RUT normalizado', async () => {
    const r = await crear({ codigo: 'PRY-X1', nombre: 'Casa Pérez', fecha_instalacion: '2026-11-30', cliente_nuevo: CLIENTE_NUEVO });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.cliente_creado, true);
    const { rows } = await db.query(
      `SELECT razon_social, es_cliente_b2b, es_cliente_b2c FROM terreno.cliente WHERE rut_cliente = '76999999-K'`);
    assert.deepEqual(rows[0], { razon_social: 'Constructora Nueva SpA', es_cliente_b2b: true, es_cliente_b2c: false });
    assert.equal(await proyectos(), 2);
  });

  test('el código sugerido es el siguiente libre del año', async () => {
    const anio = new Date().getFullYear();
    let r = await api('GET', `${BASE}/nuevo`);
    assert.equal(r.status, 200);
    assert.equal(r.body.codigo_sugerido, `PRY-${anio}-001`);
    assert.ok(r.body.clientes.some(c => c.rut === '11111111-1'));
    await crear({ codigo: `PRY-${anio}-007`, nombre: 'Uno', fecha_instalacion: '2026-12-01', rut_cliente: '11111111-1' });
    r = await api('GET', `${BASE}/nuevo`);
    assert.equal(r.body.codigo_sugerido, `PRY-${anio}-008`);
  });
});

describe('rechazos: no se escribe nada en terreno', () => {
  test('código repetido (sin distinguir mayúsculas) → 409, aunque el cliente sea nuevo', async () => {
    const r = await crear({ codigo: 'pry-test', nombre: 'Otro', fecha_instalacion: '2026-12-01', cliente_nuevo: CLIENTE_NUEVO });
    assert.equal(r.status, 409);
    assert.equal(await proyectos(), 1);
    assert.equal(await clientes(), 1);
  });

  test('datos inválidos → 400', async () => {
    const base = { codigo: 'PRY-Z', nombre: 'Proyecto', fecha_instalacion: '2026-12-01', rut_cliente: '11111111-1' };
    for (const malo of [
      { codigo: '' }, { codigo: 'con espacios' }, { nombre: 'ab' }, { fecha_instalacion: '2026-02-31' }, { fecha_instalacion: '' },
      { rut_cliente: '' }, { rut_cliente: undefined, cliente_nuevo: { ...CLIENTE_NUEVO, rut: '76999999-1' } },
      { rut_cliente: undefined, cliente_nuevo: { ...CLIENTE_NUEVO, correo: 'sin-arroba' } },
      { rut_cliente: undefined, cliente_nuevo: { ...CLIENTE_NUEVO, contacto: ' ' } },
    ]) {
      const r = await crear({ ...base, ...malo });
      assert.equal(r.status, 400, JSON.stringify(malo));
    }
    assert.equal(await proyectos(), 1);
    assert.equal(await clientes(), 1);
  });

  test('cliente inexistente → 404; cliente "nuevo" que ya existe → 409', async () => {
    let r = await crear({ codigo: 'PRY-Z', nombre: 'Proyecto', fecha_instalacion: '2026-12-01', rut_cliente: '12345678-5' });
    assert.equal(r.status, 404);
    r = await crear({ codigo: 'PRY-Z', nombre: 'Proyecto', fecha_instalacion: '2026-12-01',
                      cliente_nuevo: { ...CLIENTE_NUEVO, rut: '11111111-1' } });
    assert.equal(r.status, 409);
    assert.equal(await proyectos(), 1);
  });

  test('solo gerencia crea (jop y administrador también reciben 403)', async () => {
    for (const rol of ['jop', 'administrador']) {
      const r = await crear({ codigo: 'PRY-Z', nombre: 'Proyecto', fecha_instalacion: '2026-12-01', rut_cliente: '11111111-1' }, rol);
      assert.equal(r.status, 403, rol);
      assert.equal((await api('GET', `${BASE}/nuevo`, { rol })).status, 403, rol);
    }
    assert.equal(await proyectos(), 1);
  });
});
