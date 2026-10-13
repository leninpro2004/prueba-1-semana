import { nombreCorto } from '../utils/format';

/**
 * F-17: nombre corto (material o proveedor) para las tablas densas, con el nombre completo al
 * pasar el mouse. Si el nombre cabe, se muestra igual y sin title.
 */
export default function NombreCorto({ texto, max = 30, vacio = '—' }) {
  if (texto == null || String(texto).trim() === '') return vacio;
  const corto = nombreCorto(texto, max);
  return corto === String(texto).trim().replace(/\s+/g, ' ')
    ? <>{corto}</>
    : <span title={texto}>{corto}</span>;
}
