require('./entorno');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const app = require('../../src/index');

let servidor = null;
let base = null;

/**
 * Levanta la app en un puerto libre (el 0 deja que el SO elija), para que los
 * tests no choquen con el servidor de desarrollo si está corriendo.
 */
function levantar() {
  if (servidor) return Promise.resolve(base);
  return new Promise((resolve) => {
    servidor = app.listen(0, () => {
      base = `http://127.0.0.1:${servidor.address().port}`;
      resolve(base);
    });
  });
}

function bajar() {
  return new Promise((resolve) => {
    if (!servidor) return resolve();
    servidor.close(() => { servidor = null; base = null; resolve(); });
  });
}

/**
 * Tokens de los usuarios de la semilla, uno por rol. Se firman con el JWT_SECRET real,
 * así que pasan por el middleware de auth igual que uno de verdad.
 * B-01: el middleware toma el rol de la BD, no del token: por eso cada rol es un usuario
 * distinto (ids 1 a 5 de semilla.sql) y no basta con cambiar el `rol` del token.
 */
const USUARIOS_POR_ROL = {
  gerencia:      { id: 1, username: 'gerente.test' },
  jop:           { id: 2, username: 'jop.test' },
  tecnico:       { id: 3, username: 'tecnico.test' },
  secretaria:    { id: 4, username: 'secretaria.test' },
  administrador: { id: 5, username: 'admin.test' },
};
const token = (rol = 'gerencia') => {
  const u = USUARIOS_POR_ROL[rol];
  if (!u) throw new Error(`Rol sin usuario en la semilla: ${rol}`);
  return jwt.sign({ ...u, rol }, process.env.JWT_SECRET, { expiresIn: '1h' });
};

/**
 * Hace una petición a la API. Devuelve { status, body } siempre: los tests
 * comprueban el código de estado, así que un 4xx no debe lanzar excepción.
 *
 *   await api('POST', '/api/movimientos/salida', { body: {...} })
 *   await api('GET',  '/api/materiales', { rol: 'jop' })
 *   await api('GET',  '/api/materiales', { sinToken: true })
 *
 * F-11: si la ruta responde 428 (pide la firma de un gerente), firma como el gerente de la semilla
 * y repite la petición con el header X-Autorizacion, igual que el frontend. Así los tests que no son
 * de firmas no cambian. { sinFirma: true } devuelve el 428 tal cual, para probar el rechazo.
 */
async function api(metodo, ruta, opciones = {}) {
  const { body, rol = 'gerencia', sinToken = false, sinFirma = false, firma = null } = opciones;
  const url = await levantar();

  const headers = { 'Content-Type': 'application/json' };
  if (!sinToken) headers.Authorization = `Bearer ${token(rol)}`;
  if (firma) headers['X-Autorizacion'] = firma;

  const res = await fetch(url + ruta, {
    method: metodo,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const texto = await res.text();
  let parsed;
  try { parsed = texto ? JSON.parse(texto) : null; } catch { parsed = texto; }
  if (res.status === 428 && !sinFirma && !firma && parsed?.requiere_firma) {
    return api(metodo, ruta, { ...opciones, firma: firmaGerencia(parsed.requiere_firma) });
  }
  return { status: res.status, body: parsed };
}

/**
 * F-11: token de firma de gerencia para `accion`, con los mismos claims que firma
 * POST /api/auth/reautenticar en modo firma. `extra` pisa claims u opciones (otra acción, vencido).
 */
const firmaGerencia = (accion, extra = {}, opciones = { expiresIn: '5m' }) => jwt.sign(
  { tipo: 'firma', accion, firmante: 1, jti: crypto.randomUUID(), ...extra },
  process.env.JWT_SECRET,
  opciones
);

module.exports = { api, levantar, bajar, token, firmaGerencia };
