/** Helpers compartidos por ProductoCrear / ProductoEditar (cascada de clasificación y estilos de error). */

export const CLAS_VACIA = { categorias: [], subcategorias: [], niveles: [] };

export const subcategoriasDe = (clas, catId) =>
  catId ? clas.subcategorias.filter(s => String(s.categoria_id) === String(catId)) : [];

export const nivelesDe = (clas, subId) =>
  subId ? clas.niveles.filter(n => String(n.subcategoria_id) === String(subId)) : [];

/** Equivale a `el.style.borderColor='var(--danger)'` (+ boxShadow cuando el original lo ponía). */
export const ERR_BORDER = { borderColor: 'var(--danger)' };
export const ERR_FULL   = { borderColor: 'var(--danger)', boxShadow: '0 0 0 3px rgba(220,53,69,.12)' };
