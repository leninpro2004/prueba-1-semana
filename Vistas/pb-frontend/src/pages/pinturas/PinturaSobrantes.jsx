import { useEffect, useState } from 'react';
import { API } from '../../services/api';
import { formatQty } from '../../utils/format';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';

/**
 * Pinturas Sobrantes — conversión de pinturas/sobrantes.html (con pbPaginar, 20 por página).
 * pedidos/sobrantes.html es la misma vista sin paginación: se reutiliza con paginar={false}.
 * data-rol="gerencia" en la columna "Reservado": oculta si rol === 'jop'.
 * OPUS-16: `embebido` lo monta como pestaña dentro de la página unificada de
 * Pinturas, sin su propio encabezado ni título de página.
 */
export default function PinturaSobrantes({ paginar = true, embebido = false }) {
  usePageTitle(embebido ? 'Pinturas' : 'Pinturas Sobrantes');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const verReservado = user?.rol !== 'jop';

  const [pinturas, setPinturas] = useState(null); // null = Cargando…
  const pag = usePagination(pinturas, 20);

  useEffect(() => {
    let cancelado = false;
    (async () => {
      try {
        const data = await API.materiales.pinturasSobrantes();
        if (cancelado) return;
        if (data?.error) { showAlert('danger', data.error); return; }
        if (data?.mensaje) showAlert('info', data.mensaje);
        setPinturas(data?.pinturas || []);
      } catch (err) {
        if (!cancelado) showAlert('danger', 'Error: ' + err.message);
      }
    })();
    return () => { cancelado = true; };
  }, [showAlert]);

  const filas = pinturas === null ? [] : (paginar ? pag.items : pinturas);

  return (
    <>
      {!embebido && (
        <div className="page-header">
          <div>
            <div className="page-title">Pinturas Sobrantes</div>
            <div className="page-subtitle">Inventario de pinturas custom y no custom con stock disponible</div>
          </div>
        </div>
      )}

      <div id="alert-container"><Alert {...alert} /></div>

      {/* Tabla */}
      <div className="card">
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Color / Detalle</th>
                <th>Unidad</th>
                <th style={{ textAlign: 'right' }}>Stock total</th>
                {verReservado && <th style={{ textAlign: 'right' }}>Reservado</th>}
                <th style={{ textAlign: 'right' }}>Disponible</th>
              </tr>
            </thead>
            <tbody id="tabla-body">
              {pinturas === null && (
                <tr><td colSpan={8} style={{ textAlign: 'center', padding: 32, color: 'var(--text-secondary)' }}>Cargando…</td></tr>
              )}
              {pinturas !== null && pinturas.length === 0 && (
                <EmptyRow colSpan={8} emptyMsg="No hay pinturas sobrantes registradas" />
              )}
              {filas.map(p => {
                const stock = parseFloat(p.stock_total || 0);
                const reservado = parseFloat(p.stock_reservado || 0);
                const disponible = stock - reservado;
                const tipo = p.es_custom ? 'Custom' : 'No custom';
                const color = p.es_custom ? (p.color_custom || '—') : (p.color_no_custom || '—');
                return (
                  <tr key={p.sku}>
                    <td><code>{p.sku}</code></td>
                    <td>{p.nombre}</td>
                    <td><span className={`badge ${p.es_custom ? 'badge-warning' : 'badge-ghost'}`}>{tipo}</span></td>
                    <td>{color}</td>
                    <td>{p.unidad || '—'}</td>
                    <td style={{ textAlign: 'right' }}>{formatQty(stock)}</td>
                    {verReservado && <td style={{ textAlign: 'right' }}>{formatQty(reservado)}</td>}
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatQty(disponible)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {paginar && pinturas !== null && <Pagination {...pag} />}
      </div>
    </>
  );
}
