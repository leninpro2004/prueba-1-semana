/**
 * D66 (D56): una entrada de compra exige proveedor, precio, fecha del pedido y factura.
 * Los tests que registran una entrada cualquiera la completan con estos datos:
 *
 *   api('POST', '/api/movimientos/entrada', { body: { sku, bodega_id: 1, cantidad: 5, tipo_movimiento_id: 1, ...compra() } })
 *
 * Cada llamada lleva un número de factura distinto, para que dos entradas del mismo test
 * no queden ligadas a la misma factura sin quererlo.
 */
let n = 0;

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function compra(extra = {}) {
  n += 1;
  return {
    tipo_entrada: 'compra', proveedor_id: 1, precio_unitario: 1000,
    fecha_pedido: hoy(), factura_numero: `F-TEST-${process.pid}-${n}`, factura_fecha: hoy(),
    ...extra,
  };
}

module.exports = { compra, hoy };
