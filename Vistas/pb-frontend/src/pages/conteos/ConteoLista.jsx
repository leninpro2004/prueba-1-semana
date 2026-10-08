import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import { useAuth } from '../../hooks/useAuth';
import { badgeEstado, fechaHora } from './formato';
import ToleranciasConteo from './ToleranciasConteo';

/** CU-37: historial de conteos cíclicos. */

const RESULTADO = { conforme: 'Conforme', con_diferencias: 'Con diferencias' };

export default function ConteoLista() {
  usePageTitle('Conteo cíclico');
  const { user } = useAuth();
  const esGerencia = user?.rol === 'gerencia';
  const { alert, showAlert } = useAlert();
  const [conteos, setConteos] = useState(null);
  const [bodegas, setBodegas] = useState([]);
  const [bodegaId, setBodegaId] = useState('');

  useEffect(() => {
    API.bodegas.listar().then(b => setBodegas(b || [])).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelado = false;
    API.conteos.listar({ bodega_id: bodegaId })
      .then(c => { if (!cancelado) setConteos(Array.isArray(c) ? c : []); })
      .catch(err => { if (!cancelado) showAlert('danger', 'Error cargando conteos: ' + err.message); });
    return () => { cancelado = true; };
  }, [bodegaId, showAlert]);

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Conteo cíclico</div>
          <div className="page-subtitle">Conteos físicos por bodega (CU-37)</div>
        </div>
        <Link to="/conteos/nuevo" className="btn btn-primary" id="btn-nuevo-conteo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nuevo conteo
        </Link>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* D10: tolerancias editables, solo gerencia */}
      {esGerencia && <ToleranciasConteo />}

      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0 }}>
          <select className="form-control" id="filtro-bodega" style={{ width: 'auto' }} value={bodegaId} onChange={e => setBodegaId(e.target.value)}>
            <option value="">Todas las bodegas</option>
            {bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table id="tabla-conteos">
            <thead>
              <tr>
                <th>N°</th><th>Fecha</th><th>Bodega</th><th>Responsable</th>
                <th>Contados</th><th>No esperados</th><th>Estado</th><th></th>
              </tr>
            </thead>
            <tbody>
              {conteos === null ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--gray)' }}>Cargando conteos...</td></tr>
              ) : conteos.length === 0 ? (
                <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--gray)' }}>
                  No hay conteos registrados{bodegaId ? ' para esta bodega' : ''}. Cree uno con <Link to="/conteos/nuevo">Nuevo conteo</Link>.
                </td></tr>
              ) : conteos.map(c => (
                <tr key={c.id}>
                  <td className="td-mono">#{c.id}</td>
                  <td>{fechaHora(c.fecha_hora)}{c.justificacion && <span className="badge badge-warning" style={{ marginLeft: 6 }} title={c.justificacion}>Recuento</span>}</td>
                  <td>{c.bodega}</td>
                  <td>{c.usuario || '—'}</td>
                  <td>{c.contados} de {c.total_items}</td>
                  <td>{Number(c.no_esperados) > 0 ? c.no_esperados : '—'}</td>
                  <td>
                    {badgeEstado(c.estado)}
                    {c.resultado && (
                      <span className={'badge ' + (c.resultado === 'conforme' ? 'badge-success' : 'badge-warning')} style={{ marginLeft: 6 }}>
                        {RESULTADO[c.resultado]}
                      </span>
                    )}
                  </td>
                  <td>
                    <Link to={`/conteos/${c.id}`}>Ver</Link>
                    {/* CU-43: comparar o ver el resultado (solo gerencia) */}
                    {esGerencia && c.estado !== 'borrador' && (
                      <> · <Link to={`/conteos/${c.id}/diferencias`}>{c.estado === 'procesado' ? 'Diferencias' : 'Comparar'}</Link></>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
