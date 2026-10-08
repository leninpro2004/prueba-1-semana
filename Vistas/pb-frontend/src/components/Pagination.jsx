/**
 * Controles de paginación (markup de pbPaginar en layout.js).
 * Uso junto con usePagination:
 *   const pag = usePagination(datos);
 *   <tbody>{pag.items.map(renderFila)}</tbody> ... <Pagination {...pag} />
 * No renderiza nada si hay 1 página o menos.
 */
export default function Pagination({ pagina, totalPaginas, total, prev, next }) {
  if (!totalPaginas || totalPaginas <= 1) return null;
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
