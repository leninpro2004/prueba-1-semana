const { pool } = require('./pool');

/**
 * Helpers transaccionales compartidos (OPUS-1, extraidos aqui en OPUS-3 para que
 * los usen tambien pedidosController y reservasController).
 *
 * OJO: db/pool.query() toma un cliente NUEVO del pool en cada llamada, asi que
 * dos llamadas seguidas NO comparten transaccion. Todo lo que deba ser atomico
 * tiene que pasar por conTransaccion() y usar el `client` que recibe.
 */

/** Error de negocio: el catch lo traduce a la respuesta HTTP que corresponda. */
class ErrorNegocio extends Error {
  constructor(status, payload) {
    super(payload.error || 'Error de negocio');
    this.status  = status;
    this.payload = payload;
  }
}

/**
 * Ejecuta fn(client) dentro de BEGIN/COMMIT; ROLLBACK ante cualquier error.
 *
 * CU-106 CP2: ante serialization failure (40001) o deadlock (40P01) se reintenta
 * la transaccion COMPLETA. Reintentar una sola query dentro de una transaccion ya
 * abortada no sirve de nada.
 */
async function conTransaccion(fn, intentos = 3) {
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO ${process.env.DB_SCHEMA || 'inventario'}`);
      await client.query('BEGIN');
      const resultado = await fn(client);
      await client.query('COMMIT');
      return resultado;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* conexion ya perdida */ }
      ultimoError = err;
      if ((err.code === '40001' || err.code === '40P01') && i < intentos - 1) {
        await new Promise(r => setTimeout(r, 50 * (i + 1)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
  throw ultimoError;
}

/** ErrorNegocio -> su status; cualquier otra cosa -> 500. */
function responderError(res, err, contexto) {
  if (err instanceof ErrorNegocio) return res.status(err.status).json(err.payload);
  console.error(contexto, err);
  return res.status(500).json({ error: 'Error interno del servidor' });
}

module.exports = { ErrorNegocio, conTransaccion, responderError };
