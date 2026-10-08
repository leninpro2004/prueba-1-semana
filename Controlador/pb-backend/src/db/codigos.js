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

module.exports = { generarCodigoInterno, FORMATO_INTERNO };
