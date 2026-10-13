/**
 * F-25a' (lineamientos de composición, secciones 2 y 3): encabezado de la vista con contexto,
 * título, descripción y acciones de página. Banda blanca de borde a borde, como el Dashboard M7 de Finanzas.
 * Props: contexto (nivel 3, opcional), titulo (nivel 1), descripcion, children = acciones.
 */
export default function PageHeader({ contexto, titulo, descripcion, children }) {
  return (
    <header className="encabezado-vista">
      <div className="contenido-max encabezado-vista-fila">
        <div>
          <div className="encabezado-vista-barra" />
          {contexto && <p className="encabezado-vista-contexto">{contexto}</p>}
          <h1 className="encabezado-vista-titulo">{titulo}</h1>
          {descripcion && <p className="encabezado-vista-descripcion">{descripcion}</p>}
        </div>
        {children && <div className="encabezado-vista-acciones">{children}</div>}
      </div>
    </header>
  );
}
