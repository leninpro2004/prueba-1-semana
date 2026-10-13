import { Link } from 'react-router-dom';

/**
 * F-25a' (lineamientos de composición, sección 5): bloque con título, descripción, enlace de
 * detalle y contenido. Para gráficos, historiales, formularios o colecciones.
 */
export default function Seccion({ titulo, descripcion, ruta, textoRuta = 'Ver detalle', children }) {
  return (
    <section className="seccion">
      <div className="seccion-cabecera">
        <div>
          <h2 className="seccion-titulo">{titulo}</h2>
          {descripcion && <p className="seccion-descripcion">{descripcion}</p>}
        </div>
        {ruta && <Link to={ruta} className="seccion-enlace">{textoRuta} →</Link>}
      </div>
      {children}
    </section>
  );
}

/** Estado vacío o de carga dentro de una sección. */
export function SeccionVacia({ children }) {
  return <div className="seccion-vacia">{children}</div>;
}
