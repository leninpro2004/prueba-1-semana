require('./entorno');
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
 * Tokens de los dos usuarios de la semilla. Se firman con el JWT_SECRET real,
 * así que pasan por el middleware de auth igual que uno de verdad.
 */
const token = (rol = 'gerencia') => jwt.sign(
  rol === 'gerencia'
    ? { id: 1, username: 'gerente.test', nombre: 'Gerente Test', rol: 'gerencia' }
    : { id: 2, username: 'jop.test',     nombre: 'JOP Test',     rol: 'jop' },
  process.env.JWT_SECRET,
  { expiresIn: '1h' }
);

/**
 * CU-44: token de autorización para revertir un movimiento, con los mismos claims
 * que firma POST /api/auth/reautenticar (CU-42). `extra` pisa claims u opciones
 * para probar tokens de otro usuario, otra acción o vencidos.
 */
const autorizacion = (mov, extra = {}, opciones = { expiresIn: '5m' }) => jwt.sign(
  { uid: 1, accion: 'revertir_movimiento', mov: Number(mov), tipo: 'autorizacion', ...extra },
  process.env.JWT_SECRET,
  opciones
);

/**
 * Hace una petición a la API. Devuelve { status, body } siempre: los tests
 * comprueban el código de estado, así que un 4xx no debe lanzar excepción.
 *
 *   await api('POST', '/api/movimientos/salida', { body: {...} })
 *   await api('GET',  '/api/materiales', { rol: 'jop' })
 *   await api('GET',  '/api/materiales', { sinToken: true })
 */
async function api(metodo, ruta, opciones = {}) {
  const { body, rol = 'gerencia', sinToken = false } = opciones;
  const url = await levantar();

  const headers = { 'Content-Type': 'application/json' };
  if (!sinToken) headers.Authorization = `Bearer ${token(rol)}`;

  const res = await fetch(url + ruta, {
    method: metodo,
    headers,
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

  const texto = await res.text();
  let parsed;
  try { parsed = texto ? JSON.parse(texto) : null; } catch { parsed = texto; }
  return { status: res.status, body: parsed };
}

module.exports = { api, levantar, bajar, token, autorizacion };
