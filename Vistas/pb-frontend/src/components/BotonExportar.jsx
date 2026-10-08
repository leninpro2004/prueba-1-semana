/**
 * CU-76: botón de exportación común a todos los reportes.
 * Exc 3: sin filas el botón queda deshabilitado y lo DICE en pantalla (un tooltip
 * solo aparece al pasar el mouse y en un teléfono no aparece nunca).
 *
 * `filas`: cantidad de filas exportables. null = todavía no hay reporte generado
 * (deshabilitado, sin aviso); 0 = reporte sin datos (deshabilitado, con aviso).
 */
export default function BotonExportar({ onClick, filas, cargando = false, etiqueta = 'Exportar CSV',
                                        className = 'btn btn-secondary', id }) {
  const hayDatos = filas > 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button type="button" className={className} id={id} onClick={onClick} disabled={!hayDatos || cargando}
              title={hayDatos ? 'Descargar en CSV' : 'No hay datos para exportar'}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="14" height="14"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        {cargando ? 'Exportando…' : etiqueta}
      </button>
      {filas === 0 && <span style={{ fontSize: 11, color: 'var(--gray)', whiteSpace: 'nowrap' }}>Sin datos para exportar</span>}
    </span>
  );
}
