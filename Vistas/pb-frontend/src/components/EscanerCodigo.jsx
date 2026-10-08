import { useRef, useState } from 'react';
import { API } from '../services/api';
import Alert from './Alert';

/**
 * CU-30: campo de lectura por escáner.
 *
 * El lector de códigos funciona como un TECLADO: escribe los dígitos y manda Enter.
 * Por eso no hay forma de saber desde el navegador si está conectado (Exc 2): el
 * mismo campo acepta el código escrito a mano o el SKU, y el selector de producto
 * del formulario sigue disponible.
 *
 * <EscanerCodigo onProducto={(p) => ...} />
 *   p = { sku, nombre, estado, unidad_medida, codigo_barras, bodegas: [{ bodega_id, bodega_nombre, cantidad_fisica, disponible }] }
 * Solo se llama con productos ACTIVOS: un inactivo se bloquea aquí (Exc 3).
 * Con permitirInactivos (conteo cíclico, CU-37) también se aceptan: contar no es
 * un movimiento, y un producto dado de baja puede seguir en el estante.
 */
export default function EscanerCodigo({ onProducto, autoFocus = true, permitirInactivos = false }) {
  const [valor, setValor] = useState('');
  const [buscando, setBuscando] = useState(false);
  const [aviso, setAviso] = useState(null); // { type, message }
  const inputRef = useRef(null);

  const reintentar = () => {
    // El campo queda listo para el siguiente intento, con el texto seleccionado
    requestAnimationFrame(() => inputRef.current?.select());
  };

  const procesar = async () => {
    const texto = valor.trim();
    if (!texto || buscando) return;
    setBuscando(true);
    try {
      const p = await API.codigos.resolver(texto);
      if (!p) return; // 401: el handler global ya redirige al login
      if (p.estado !== 'activo' && !permitirInactivos) {
        // Exc 3: se bloquea antes de pedir la cantidad
        setAviso({
          type: 'danger',
          message: <>El producto <strong>{p.sku} — {p.nombre}</strong> está inactivo o dado de baja. No se pueden registrar movimientos.</>,
        });
        reintentar();
        return;
      }
      setAviso({
        type: 'success',
        message: <>Producto identificado: <strong>{p.sku} — {p.nombre}</strong> ({p.unidad_medida || 'sin unidad'})</>,
      });
      setValor('');
      onProducto(p);
    } catch (err) {
      if (err.status === 404) {
        // Exc 1: código desconocido → ingreso manual
        setAviso({
          type: 'warning',
          message: <>El código <strong>{texto}</strong> no corresponde a ningún producto del catálogo. Escriba el SKU aquí o elíjalo en la lista de productos.</>,
        });
      } else {
        setAviso({ type: 'danger', message: err.message || 'No se pudo buscar el código.' });
      }
      reintentar();
    } finally {
      setBuscando(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      // Dentro de un <form>, Enter enviaría el formulario: el lector manda Enter al final
      e.preventDefault();
      procesar();
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="section-label">Lectura por escáner (CU-30)</div>
      <div className="form-group" style={{ marginBottom: aviso ? 10 : 0 }}>
        <label className="form-label" htmlFor="escaner-codigo">Código de barras o SKU</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            ref={inputRef}
            className="form-control"
            id="escaner-codigo"
            autoFocus={autoFocus}
            autoComplete="off"
            placeholder="Escanee el código o escriba el SKU y presione Enter"
            value={valor}
            onChange={e => setValor(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={buscando}
          />
          <button type="button" className="btn btn-secondary" onClick={procesar} disabled={buscando || !valor.trim()}>
            {buscando ? 'Buscando...' : 'Buscar'}
          </button>
        </div>
        <div className="form-hint">
          Con el cursor en este campo, escanee la etiqueta del producto. Si el lector no responde, escriba el código o el SKU.
        </div>
      </div>
      <Alert {...aviso} style={{ marginBottom: 0 }} />
    </div>
  );
}
