import { useEffect, useMemo, useState } from 'react';

/**
 * usePagination(datos, porPagina=20) → { pagina, totalPaginas, items, prev, next, total }
 * Reproduce la lógica de pbPaginar (layout.js): 20 por página, reinicia a la
 * página 1 cuando cambia el array de datos.
 */
export function usePagination(datos, porPagina = 20) {
  const lista = useMemo(() => (Array.isArray(datos) ? datos : []), [datos]);
  const [pagina, setPagina] = useState(1);

  useEffect(() => { setPagina(1); }, [lista]);

  const totalPaginas = Math.ceil(lista.length / porPagina);
  const items = useMemo(() => {
    const inicio = (pagina - 1) * porPagina;
    return lista.slice(inicio, inicio + porPagina);
  }, [lista, pagina, porPagina]);

  return {
    pagina,
    totalPaginas,
    total: lista.length,
    items,
    prev: () => setPagina(p => (p > 1 ? p - 1 : p)),
    next: () => setPagina(p => (p < totalPaginas ? p + 1 : p)),
  };
}
