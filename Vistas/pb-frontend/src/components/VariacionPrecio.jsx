import { formatMoney } from '../utils/format';

const gris = { fontSize: 11, color: 'var(--gray)' };

/**
 * CU-64: variacion de un precio respecto del registro anterior del mismo producto y
 * proveedor. Sube en rojo (mas costo), baja en verde.
 *
 *   <VariacionPrecio abs={p.variacion_abs} pct={p.variacion_pct}
 *                    anterior={p.precio_anterior} registros={p.registros_producto} />
 */
export default function VariacionPrecio({ abs, pct, anterior, registros }) {
  // Exc 2: un unico precio para el producto, no hay con que comparar
  if (registros === 1) return <span style={gris}>Único precio: sin variación calculable</span>;
  if (anterior == null) return <span style={gris}>Primer registro</span>;

  const a = parseFloat(abs);
  if (a === 0) return <span className="badge badge-gray" style={{ fontSize: 10 }}>Sin cambio</span>;

  const sube = a > 0;
  const signo = sube ? '+' : '−';
  const p = pct != null ? parseFloat(pct) : null;
  return (
    <span style={{ fontWeight: 600, fontSize: 12, color: sube ? 'var(--danger)' : 'var(--success)', whiteSpace: 'nowrap' }}>
      {sube ? '▲' : '▼'} {signo}{formatMoney(Math.abs(a))}
      {p != null && <> ({signo}{Math.abs(p).toLocaleString('es-CL', { maximumFractionDigits: 2 })}%)</>}
    </span>
  );
}
