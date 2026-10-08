/**
 * Carga del entorno de test. DEBE requerirse ANTES que cualquier cosa que
 * toque la base (src/db/pool.js lee process.env al cargarse).
 *
 * Orden: primero .env (base) y encima .env.test, que sobreescribe DB_NAME.
 * dotenv no pisa variables ya definidas, así que el override es explícito.
 */
const path = require('path');

const RAIZ = path.resolve(__dirname, '..', '..');

require('dotenv').config({ path: path.join(RAIZ, '.env') });
require('dotenv').config({ path: path.join(RAIZ, '.env.test'), override: true });

/* ══════════════════════════════════════════════════════════════════
   RED DE SEGURIDAD

   Los tests hacen TRUNCATE de todas las tablas. Si por un error de
   configuración apuntaran a la base real, se perderían los datos del
   sistema. Por eso se exige que el nombre termine en `_test`: es una
   condición barata de cumplir e imposible de cumplir por accidente.
   ══════════════════════════════════════════════════════════════════ */
if (!process.env.DB_NAME || !process.env.DB_NAME.endsWith('_test')) {
  console.error(
    `\n✖ Los tests apuntan a la base "${process.env.DB_NAME || '(sin definir)'}", ` +
    'que NO termina en "_test".\n' +
    '  Se abortó antes de tocar nada. Revisá Controlador/pb-backend/.env.test\n'
  );
  process.exit(1);
}

// Silencia el ruido de los console.error que los controllers imprimen al
// probar los caminos de error. Se puede ver todo con TEST_VERBOSE=1.
if (!process.env.TEST_VERBOSE) {
  console.error = () => {};
  console.warn  = () => {};
  console.log   = () => {};
}

module.exports = { RAIZ };
