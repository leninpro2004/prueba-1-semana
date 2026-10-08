import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

/**
 * Sesión 15 (punto 22): selector de producto con búsqueda. Reemplaza los <select> de SKU,
 * que no sirven con un catálogo real de cientos de productos.
 *
 * Se escribe parte del SKU o del nombre (sin distinguir mayúsculas ni tildes) y se
 * despliegan las coincidencias. Teclado: ↑ ↓ para moverse, Enter elige, Esc cierra.
 * Se usa como un <select>: `value` es el SKU elegido ('' = ninguno) y `onChange(sku)`.
 *
 *   <SelectorProducto opciones={materiales} value={sku} onChange={setSku} id="sku" />
 *
 * opciones: [{ sku, nombre, detalle? }] — `detalle` se muestra en gris (ej. "stock 3").
 * vacio:    texto de la opción "ninguno" arriba de la lista (ej. "Todos" en un filtro).
 *           Sin `vacio`, borrar el texto también deja el valor en ''.
 * Un `value` que no está en las opciones (ej. un material inactivo de una receta) se
 * muestra tal cual.
 */

const MAX = 50;
const normalizar = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export default function SelectorProducto({
  opciones = [], value = '', onChange, id, placeholder = 'Escriba el SKU o el nombre…',
  disabled = false, style, vacio = null, autoFocus = false, 'aria-label': ariaLabel,
}) {
  const porSku = useMemo(() => new Map(opciones.map(o => [o.sku, o])), [opciones]);
  const etiqueta = (sku) => {
    if (!sku) return '';
    const o = porSku.get(sku);
    return o ? `${o.sku} — ${o.nombre}` : sku;
  };

  const [texto, setTexto] = useState('');          // lo que se escribe; solo cuenta mientras se edita
  const [abierto, setAbierto] = useState(false);
  const [editando, setEditando] = useState(false);
  const [resaltado, setResaltado] = useState(0);
  const listaRef = useRef(null);
  const inputRef = useRef(null);
  const recienElegido = useRef(false);   // tras elegir, el texto queda seleccionado
  // La lista va en position: fixed bajo el campo, para que no la recorte una tabla con scroll
  const [pos, setPos] = useState(null);
  const abrir = () => {
    const r = inputRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 260) });
    setAbierto(true);
  };

  // Si la página o un contenedor hace scroll, la lista se cierra (quedaría flotando mal ubicada)
  useEffect(() => {
    if (!abierto) return undefined;
    const alScroll = (e) => { if (!listaRef.current?.contains(e.target)) setAbierto(false); };
    window.addEventListener('scroll', alScroll, true);
    window.addEventListener('resize', alScroll);
    return () => { window.removeEventListener('scroll', alScroll, true); window.removeEventListener('resize', alScroll); };
  }, [abierto]);

  // Se selecciona apenas el campo muestra lo elegido: si se sigue escribiendo, reemplaza
  useLayoutEffect(() => {
    if (recienElegido.current) { recienElegido.current = false; inputRef.current?.select(); }
  });

  // Fuera de la edición se muestra lo elegido: si el valor cambia desde fuera (escáner,
  // limpiar el formulario), el campo lo sigue sin necesidad de sincronizar estado.
  const mostrado = editando ? texto : etiqueta(value);

  const coincidencias = useMemo(() => {
    const q = normalizar(editando ? texto : '').trim();
    const lista = q
      ? opciones.filter(o => normalizar(o.sku).includes(q) || normalizar(o.nombre).includes(q))
      : opciones;
    return lista.slice(0, MAX);
  }, [opciones, texto, editando]);
  const items = vacio != null ? [{ sku: '', nombre: vacio, esVacio: true }, ...coincidencias] : coincidencias;

  const elegir = (item) => {
    setEditando(false);
    setAbierto(false);
    recienElegido.current = true;
    if (item.sku !== value) onChange?.(item.sku);
  };

  const cerrar = () => {
    setAbierto(false);
    if (!editando) return;
    setEditando(false);
    // Texto borrado = ninguno; si no, se vuelve a mostrar lo elegido
    if (!texto.trim() && value) onChange?.('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!abierto) abrir(); setResaltado(i => Math.min(i + 1, items.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setResaltado(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      // Enter nunca envía el formulario desde aquí: elige la opción resaltada
      e.preventDefault();
      if (abierto && items[resaltado]) elegir(items[resaltado]);
    } else if (e.key === 'Escape') { e.preventDefault(); setEditando(false); setAbierto(false); }
  };

  // La opción resaltada queda a la vista al moverse con el teclado
  useEffect(() => {
    listaRef.current?.children[resaltado]?.scrollIntoView?.({ block: 'nearest' });
  }, [resaltado]);

  return (
    <div style={{ position: 'relative' }}>
      <input
        ref={inputRef} className="form-control" id={id} type="text" autoComplete="off" disabled={disabled} autoFocus={autoFocus}
        role="combobox" aria-expanded={abierto} aria-autocomplete="list" aria-label={ariaLabel}
        placeholder={vacio && !value ? vacio : placeholder} style={style} value={mostrado}
        onFocus={(e) => { e.target.select(); setTexto(etiqueta(value)); abrir(); setResaltado(0); }}
        onChange={(e) => { setTexto(e.target.value); setEditando(true); if (!abierto) abrir(); setResaltado(vacio != null && e.target.value ? 1 : 0); }}
        // Ya con foco: el clic reabre la lista y, si no se está escribiendo, selecciona todo
        // (si no, el cursor queda en medio de "SKU — nombre" y lo escrito se intercala)
        onClick={(e) => { if (!editando) e.target.select(); if (!abierto) { abrir(); setResaltado(0); } }}
        onBlur={cerrar}
        onKeyDown={onKeyDown}
      />
      {abierto && !disabled && pos && (
        <ul ref={listaRef} role="listbox"
          style={{ position: 'fixed', zIndex: 1000, top: pos.top, left: pos.left, width: pos.width, maxHeight: 260, overflowY: 'auto', margin: 0,
                   background: 'var(--white)', border: '1px solid var(--gray-mid)', borderRadius: 'var(--radius-md)',
                   boxShadow: 'var(--shadow-md)', listStyle: 'none', padding: 4 }}>
          {items.length === 0 && <li style={{ padding: '8px 10px', fontSize: 12, color: 'var(--gray)' }}>Sin coincidencias</li>}
          {items.map((o, i) => (
            <li key={o.sku || '__vacio'} role="option" aria-selected={o.sku === value}
              onMouseDown={(e) => { e.preventDefault(); elegir(o); }}
              onMouseEnter={() => setResaltado(i)}
              style={{ padding: '7px 10px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 13,
                       background: i === resaltado ? 'var(--orange-light)' : 'transparent' }}>
              {o.esVacio ? <span style={{ color: 'var(--gray)' }}>{o.nombre}</span> : (
                <>
                  <code style={{ fontWeight: 600 }}>{o.sku}</code> — {o.nombre}
                  {o.detalle && <span style={{ color: 'var(--gray)', fontSize: 11 }}> · {o.detalle}</span>}
                </>
              )}
            </li>
          ))}
          {coincidencias.length === MAX && (
            <li style={{ padding: '6px 10px', fontSize: 11, color: 'var(--gray)' }}>Se muestran los primeros {MAX}: escriba más para acotar.</li>
          )}
        </ul>
      )}
    </div>
  );
}
