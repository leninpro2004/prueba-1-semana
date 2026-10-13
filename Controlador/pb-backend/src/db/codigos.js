/**
 * CU-30: codigos de barras internos (decision D3).
 *
 * Un solo codigo por SKU, solo digitos y con prefijo 2: GS1 reserva los prefijos
 * 20 a 29 para uso interno, asi que no choca con codigos de fabrica reales.
 * Formato: '2' + la secuencia rellenada a 11 digitos = 12 digitos en total.
 *
 * La tabla NO tiene CHECK de formato a proposito (deja la puerta abierta a codigos
 * de proveedor); el formato se garantiza aqui, al generar.
 *
 * Recibe el `client` de una transaccion abierta: se llama junto con el INSERT del
 * material, dentro de conTransaccion().
 */

const FORMATO_INTERNO = /^2\d{11}$/;

/** Genera y guarda el codigo interno del SKU. Devuelve el codigo. */
async function generarCodigoInterno(client, sku) {
  const { rows } = await client.query(
    `INSERT INTO material_codigo_barras (material_sku, material_codigo_barras)
     VALUES ($1, '2' || lpad(nextval('seq_codigo_barras_interno')::text, 11, '0'))
     RETURNING material_codigo_barras AS codigo`,
    [sku]
  );
  const codigo = rows[0].codigo;
  // Con 11 digitos la secuencia no deberia desbordar nunca; si lo hiciera, se
  // aborta la transaccion en vez de guardar un codigo con otro largo.
  if (!FORMATO_INTERNO.test(codigo)) {
    throw new Error(`Codigo interno con formato invalido: ${codigo}`);
  }
  return codigo;
}

/** Minúsculas, sin tildes y con un solo espacio: así se comparan los nombres (igual que el importador). */
function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** F-03: prefijo de 3 letras para el SKU: el de la categoría de la clasificación (MAT si no tiene letras). */
function prefijoSku(texto) {
  const letras = normalizar(texto).toUpperCase().replace(/[^A-Z]/g, '');
  return letras.length >= 3 ? letras.slice(0, 3) : 'MAT';
}

/**
 * F-03 y F-23b: SKU [CAT]-[NOMBRE]-NNN (máximo 3 + 1 + 6 + 1 + 3 = 14 caracteres; CHECK 4 a 16).
 * El correlativo sigue al mayor que ya exista con la misma raíz. Recibe el `client` de una transacción.
 */
async function generarSku(client, categoria, nombre) {
  const palabra = normalizar(nombre).toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').trim().split(/\s+/)[0] || 'ITEM';
  const raiz = `${prefijoSku(categoria)}-${palabra.slice(0, 6)}-`;
  const { rows } = await client.query(
    `SELECT COALESCE(MAX(substring(material_sku FROM $2)::int), 0) AS ultimo
     FROM material WHERE material_sku LIKE $1 AND material_sku ~ $3`,
    [raiz + '%', `^${raiz}(\\d+)$`, `^${raiz}\\d+$`]
  );
  const siguiente = rows[0].ultimo + 1;
  if (siguiente > 999) throw new Error(`Se agotaron los correlativos de ${raiz}`);
  return raiz + String(siguiente).padStart(3, '0');
}

module.exports = { generarCodigoInterno, FORMATO_INTERNO, generarSku, prefijoSku, normalizar };
