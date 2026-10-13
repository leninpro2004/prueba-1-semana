/**
 * Controles de paginación (markup de pbPaginar en layout.js).
 * Uso junto con usePagination:
 *   const pag = usePagination(datos);
 *   <tbody>{pag.items.map(renderFila)}</tbody> ... <Pagination {...pag} />
 * B-10: con una sola página muestra solo "N registros" (para que no parezca que falta algo);
 * sin registros no muestra nada (la tabla ya tiene su mensaje de vacío).
 */
export default function Pagination({ pagina, totalPaginas, total, prev, next }) {
  const n = Number(total) || 0;
  if (!n) return null;
  if (!totalPaginas || totalPaginas <= 1) {
    return (
      <div style={{ textAlign: 'center', padding: '12px 0', fontSize: 13, color: 'var(--text-secondary,#666)' }}>
        {n} registro{n === 1 ? '' : 's'}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0', fontSize: 13 }}>
      <button className="btn btn-ghost btn-sm" disabled={pagina <= 1} onClick={prev}>← Anterior</button>
      <span style={{ color: 'var(--text-secondary,#666)' }}>
        Página {pagina} de {totalPaginas} · {total} registros
      </span>
      <button className="btn btn-ghost btn-sm" disabled={pagina >= totalPaginas} onClick={next}>Siguiente →</button>
    </div>
  );
}

/** Fila vacía equivalente al emptyMsg de pbPaginar. */
export function EmptyRow({ colSpan = 1, emptyMsg = 'No hay datos para mostrar' }) {
  return (
    <tr>
      <td colSpan={colSpan} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary,#888)' }}>
        {emptyMsg}
      </td>
    </tr>
  );
}
