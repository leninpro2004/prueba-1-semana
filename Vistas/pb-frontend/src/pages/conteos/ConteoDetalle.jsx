import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert from '../../components/Alert';
import { badgeEstado, fechaHora } from './formato';
import AlertasConteo from './AlertasConteo';

/**
 * CU-37: detalle de un conteo, en solo lectura. Muestra lo contado, no el stock
 * teórico: la comparación contra el sistema es de CU-43.
 */

const cantidad = (v) => parseFloat(v).toLocaleString('es-CL', { maximumFractionDigits: 4 });

export default function ConteoDetalle() {
  const { id } = useParams();
  const { state } = useLocation();
  usePageTitle('Conteo #' + id);
  const { user } = useAuth();
  const esGerencia = user?.rol === 'gerencia';
  const [conteo, setConteo] = useState(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0); // recarga tras generar alertas (CU-57)

  useEffect(() => {
    let cancelado = false;
    API.conteos.obtener(id)
      .then(c => { if (!cancelado) setConteo(c); })
      .catch(err => { if (!cancelado) setError(err.message); });
    return () => { cancelado = true; };
  }, [id, version]);

  const lineas = conteo?.lineas || [];
  const contados = lineas.filter(l => l.cantidad_contada !== null).length;
  const sinContar = lineas.length - contados;
  const noEsperados = lineas.filter(l => l.no_esperado).length;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Conteo #{id}</div>
          <div className="page-subtitle">{conteo ? `${conteo.bodega} · ${fechaHora(conteo.fecha_hora)}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/conteos" className="btn btn-secondary">← Volver a conteos</Link>
          {/* CU-43: la comparación muestra el teórico → solo gerencia */}
          {esGerencia && conteo && conteo.estado !== 'borrador' && (
            <Link to={`/conteos/${id}/diferencias`} className="btn btn-primary" id="btn-diferencias">
              {conteo.estado === 'procesado' ? 'Ver diferencias' : 'Comparar con el sistema'}
            </Link>
          )}
        </div>
      </div>

      <div id="alert-container">
        {state?.mensaje && <Alert type="success" message={state.mensaje} />}
        {error && <Alert type="danger" message={error} />}
      </div>

      {conteo && (
        <>
          <AlertasConteo conteo={conteo} onGeneradas={() => setVersion(v => v + 1)} />

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="form-row" style={{ marginBottom: 12 }}>
              <div><div className="form-label">Bodega</div><strong>{conteo.bodega}</strong></div>
              <div><div className="form-label">Responsable</div>{conteo.usuario || '—'}</div>
              <div><div className="form-label">Estado</div>{badgeEstado(conteo.estado)}</div>
            </div>
            <div className="form-row" style={{ marginBottom: conteo.justificacion ? 12 : 0 }}>
              <div><div className="form-label">Contados</div>{contados} de {lineas.length}</div>
              <div><div className="form-label">Sin contar</div>{sinContar}</div>
              <div><div className="form-label">No esperados</div>{noEsperados}</div>
            </div>
            {conteo.justificacion && (
              <div><div className="form-label">Justificación del recuento</div><p style={{ margin: 0, fontSize: 13 }}>{conteo.justificacion}</p></div>
            )}
          </div>

          <div className="card">
            <div className="section-label">Cantidades contadas</div>
            <div className="table-wrap">
              <table id="tabla-detalle-conteo">
                <thead>
                  <tr><th>SKU</th><th>Producto</th><th>Cantidad contada</th><th>Unidad</th><th>Observación</th></tr>
                </thead>
                <tbody>
                  {lineas.map(l => (
                    <tr key={l.sku}>
                      <td className="td-mono">{l.sku}</td>
                      <td>{l.nombre}{l.no_esperado && <span className="badge badge-warning" style={{ marginLeft: 6 }}>No esperado</span>}</td>
                      <td>{l.cantidad_contada === null
                        ? <span className="badge badge-gray">Sin contar</span>
                        : <strong>{cantidad(l.cantidad_contada)}</strong>}</td>
                      <td style={{ color: 'var(--gray)', fontSize: 13 }}>{l.unidad_medida || '—'}</td>
                      <td style={{ fontSize: 13 }}>{l.observacion || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
