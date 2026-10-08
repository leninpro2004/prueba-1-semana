import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { formatMoney } from '../../utils/format';
import { exportarCSV } from '../../utils/csvExport';
import BotonExportar from '../../components/BotonExportar';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import Alert, { useAlert } from '../../components/Alert';
import Pagination, { EmptyRow } from '../../components/Pagination';
import { usePagination } from '../../hooks/usePagination';
import { TabAsignaciones, TabDepreciacion, TabMantenimiento } from './HerramientaGestion';
import { ocultaMontos } from '../../utils/user';

// OPUS-13: la página pasa de ser un listado a la gestión completa de herramientas
const TABS = [
  ['inventario', 'Inventario'],
  ['asignaciones', 'Asignaciones'],
  ['depreciacion', 'Depreciación'],
  ['mantenimiento', 'Mantenimiento'],
];

/**
 * Herramientas — OPUS-10 (Req #5, parcial).
 * Listado de materiales marcados como herramienta, con su stock y su valorización.
 * El valor unitario sale de material_valor_adquisicion y, si no está cargado,
 * cae al precio referencial del proveedor principal.
 * Los montos no se muestran al rol jop (el backend tampoco los envía).
 */
export default function HerramientaLista() {
  usePageTitle('Herramientas');
  const { user } = useAuth();
  const { alert, showAlert } = useAlert();
  const puedeEditar = user?.rol === 'gerencia';

  const [tab, setTab] = useState('inventario');
  const [catalogo, setCatalogo] = useState({ empleados: [], areas: [] });
  const [datos, setDatos] = useState(null);   // { resumen, herramientas, muestra_valores }
  const [buscar, setBuscar] = useState('');
  const [bodegaId, setBodegaId] = useState('');
  const [estado, setEstado] = useState('activo');
  const [bodegas, setBodegas] = useState([]);

  // Edición inline del valor de adquisición
  const [editSku, setEditSku] = useState(null);
  const [editValor, setEditValor] = useState('');
  const [editFecha, setEditFecha] = useState('');

  const cargar = useCallback(async () => {
    try {
      const d = await API.herramientas.listar({
        buscar: buscar || null,
        bodega_id: bodegaId || null,
        estado: estado || null,
      });
      setDatos(d);
    } catch (err) {
      showAlert('danger', 'Error cargando herramientas: ' + err.message);
      setDatos({ resumen: {}, herramientas: [] });
    }
  }, [buscar, bodegaId, estado, showAlert]);

  useEffect(() => { cargar(); }, [cargar]);

  useEffect(() => {
    API.bodegas.listar()
      .then(b => setBodegas(b || []))
      .catch(e => console.warn('Error cargando bodegas:', e.message));
    // OPUS-13: empleados y áreas para el formulario de asignación
    API.herramientas.catalogo()
      .then(c => setCatalogo(c || { empleados: [], areas: [] }))
      .catch(e => console.warn('Error cargando catálogo de herramientas:', e.message));
  }, []);

  const abrirEdicion = (h) => {
    setEditSku(h.sku);
    setEditValor(h.valor_adquisicion != null ? String(h.valor_adquisicion) : '');
    setEditFecha(h.fecha_adquisicion || '');
  };

  const guardarEdicion = async (sku) => {
    const valor = editValor === '' ? null : parseFloat(editValor);
    if (valor != null && (isNaN(valor) || valor < 0)) {
      showAlert('warning', 'El valor de adquisición debe ser un número mayor o igual a 0.');
      return;
    }
    try {
      const resp = await API.herramientas.actualizar(sku, {
        valor_adquisicion: valor,
        fecha_adquisicion: editFecha || null,
      });
      setEditSku(null);
      showAlert('success', resp?.message || 'Herramienta actualizada');
      cargar();
    } catch (err) {
      showAlert('danger', 'Error al guardar: ' + err.message);
    }
  };

  const lista = datos?.herramientas || [];
  const resumen = datos?.resumen || {};
  const verValores = datos?.muestra_valores !== false && !ocultaMontos(user);
  const pag = usePagination(lista, 20);

  const exportar = () => {
    const headers = ['SKU', 'Nombre', 'Categoría', 'Estado', { titulo: 'Stock', formato: 'numero' }, 'Unidad', 'Ubicación'];
    if (verValores) {
      headers.push({ titulo: 'Valor unitario', formato: 'clp' }, 'Origen del valor',
                   { titulo: 'Valor total', formato: 'clp' }, { titulo: 'Fecha adquisición', formato: 'fecha' });
    }
    headers.push({ titulo: 'Prestadas', formato: 'numero' });
    const rows = lista.map(h => {
      const row = [
        h.sku,
        h.nombre || '',
        h.categoria_funcional || h.categoria_general || '',
        h.estado || '',
        h.stock_total,
        h.unidad || '',
        (h.bodegas || []).map(b => `${b.bodega} (${b.cantidad})`).join(' / '),
      ];
      if (verValores) {
        row.push(
          h.valor_unitario != null ? h.valor_unitario : '',
          h.origen_valor === 'adquisicion' ? 'Valor de adquisición'
            : h.origen_valor === 'referencial' ? 'Precio referencial' : 'Sin valor',
          h.valor_total != null ? h.valor_total : '',
          h.fecha_adquisicion || '',
        );
      }
      row.push(h.prestados);
      return row;
    });
    try { exportarCSV('herramientas', headers, rows); } catch (e) { showAlert('danger', e.message); }
  };

  const colSpan = verValores ? (puedeEditar ? 9 : 8) : 6;

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Herramientas</div>
          <div className="page-subtitle">Inventario de herramientas y su valorización</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link to="/productos" className="btn btn-ghost">← Productos</Link>
        </div>
      </div>

      <div id="alert-container"><Alert {...alert} /></div>

      {/* OPUS-13: pestañas de gestión */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid var(--border)' }}>
        {TABS.map(([k, label]) => (
          <button key={k} className={'btn btn-ghost tab-btn' + (tab === k ? ' active' : '')}
            id={'tab-' + k}
            style={{ borderRadius: 0, marginBottom: -2, borderBottom: tab === k ? '2px solid var(--primary)' : 'none' }}
            onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {tab === 'asignaciones' && (
        <TabAsignaciones herramientas={lista} catalogo={catalogo} avisar={showAlert} onCambio={cargar} />
      )}
      {tab === 'depreciacion' && verValores && (
        <TabDepreciacion avisar={showAlert} puedeEditar={puedeEditar} />
      )}
      {tab === 'depreciacion' && !verValores && (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          La valorización contable solo está disponible para gerencia y administración.
        </div>
      )}
      {tab === 'mantenimiento' && (
        <TabMantenimiento herramientas={lista} avisar={showAlert} />
      )}

      {/* KPIs */}
      {tab === 'inventario' && (
      <>
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <div className="kpi-card">
          <div className="kpi-label">Herramientas</div>
          <div className="kpi-value">{resumen.total_herramientas ?? '—'}</div>
          <div className="kpi-sub">Materiales marcados como herramienta</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Unidades en stock</div>
          <div className="kpi-value">{resumen.stock_total ?? '—'}</div>
          <div className="kpi-sub">{resumen.sin_stock ? resumen.sin_stock + ' sin stock' : 'Todas con stock'}</div>
        </div>
        {verValores && (
          <div className="kpi-card kpi-success">
            <div className="kpi-label">Valorización total</div>
            <div className="kpi-value" style={{ color: 'var(--success)' }}>{formatMoney(resumen.valor_total || 0)}</div>
            <div className="kpi-sub">Stock × valor unitario</div>
          </div>
        )}
        <div className="kpi-card kpi-warning">
          <div className="kpi-label">Prestadas</div>
          <div className="kpi-value warning">{resumen.prestadas ?? 0}</div>
          <div className="kpi-sub">Préstamos vigentes</div>
        </div>
      </div>

      {/* La valorización es parcial si faltan valores: decirlo, no mostrar un total engañoso */}
      {verValores && resumen.sin_valor > 0 && (
        <div className="alert alert-warning" style={{ marginBottom: 16, fontSize: 13 }}>
          ⚠ Valorización parcial: {resumen.sin_valor} de {resumen.total_herramientas} herramienta(s) no tienen
          valor de adquisición ni precio referencial, así que no suman al total.
          {puedeEditar && ' Puede cargarlo desde la columna "Valor unitario".'}
        </div>
      )}

      {/* Filtros */}
      <div className="card card-sm" style={{ marginBottom: 16 }}>
        <div className="filter-row" style={{ marginBottom: 0, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label className="form-label" style={{ marginBottom: 4 }}>Buscar</label>
            <input className="form-control" id="filter-buscar" placeholder="SKU o nombre"
              value={buscar} onChange={e => setBuscar(e.target.value)} />
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Bodega</label>
            <select className="form-control" id="filter-bodega" style={{ width: 'auto' }}
              value={bodegaId} onChange={e => setBodegaId(e.target.value)}>
              <option value="">Todas</option>
              {bodegas.map(b => <option key={b.id} value={b.id}>{b.nombre || ('Bodega #' + b.id)}</option>)}
            </select>
          </div>
          <div>
            <label className="form-label" style={{ marginBottom: 4 }}>Estado</label>
            <select className="form-control" id="filter-estado" style={{ width: 'auto' }}
              value={estado} onChange={e => setEstado(e.target.value)}>
              <option value="activo">Activas</option>
              <option value="inactivo">Inactivas</option>
              <option value="todos">Todas</option>
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn btn-ghost btn-sm" id="btn-limpiar"
              onClick={() => { setBuscar(''); setBodegaId(''); setEstado('activo'); }}>Limpiar filtros</button>
            {/* CU-76: cada pestaña exporta su propia tabla; esta, el inventario filtrado */}
            <BotonExportar id="btn-exportar" className="btn btn-secondary btn-sm" onClick={exportar}
                           filas={datos ? lista.length : null} etiqueta="Exportar inventario" />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>SKU</th><th>Herramienta</th><th>Categoría</th>
                <th style={{ textAlign: 'right' }}>Stock</th>
                <th>Ubicación</th>
                {verValores && <th style={{ textAlign: 'right' }}>Valor unitario</th>}
                {verValores && <th style={{ textAlign: 'right' }}>Valor total</th>}
                <th>Prestada a</th>
                {verValores && puedeEditar && <th style={{ textAlign: 'center' }}>Acción</th>}
              </tr>
            </thead>
            <tbody id="herramientas-body">
              {!datos && <tr><td colSpan={colSpan} style={{ textAlign: 'center', padding: 32 }}>Cargando…</td></tr>}
              {datos && lista.length === 0 && (
                <EmptyRow colSpan={colSpan} emptyMsg={
                  <div className="empty-state">
                    <div className="empty-state-icon">🔧</div>
                    <p>No hay herramientas que coincidan con los filtros. Un material se cuenta como herramienta
                      cuando está marcado como tal.</p>
                  </div>
                } />
              )}
              {datos && pag.items.map(h => {
                const editando = editSku === h.sku;
                const inactivo = h.estado !== 'activo';
                return (
                  <tr key={h.sku} style={inactivo ? { opacity: 0.6 } : undefined}>
                    <td><Link to={`/productos/${encodeURIComponent(h.sku)}`}><code>{h.sku}</code></Link></td>
                    <td>
                      <div style={{ fontWeight: 500, fontSize: 13 }}>{h.nombre}</div>
                      {inactivo && <span className="badge badge-gray" style={{ fontSize: 10 }}>{h.estado}</span>}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>{h.categoria_funcional || h.categoria_general || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {h.stock_total}
                      {h.unidad && <span style={{ fontWeight: 400, fontSize: 11, color: 'var(--text-secondary)' }}> {h.unidad}</span>}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>
                      {(h.bodegas || []).length === 0
                        ? '—'
                        : h.bodegas.map(b => `${b.bodega} (${b.cantidad})`).join(' · ')}
                    </td>
                    {verValores && (
                      <td style={{ textAlign: 'right' }}>
                        {editando ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                            <input className="form-control" type="number" min={0} step="0.01" style={{ width: 120, fontSize: 12 }}
                              value={editValor} onChange={e => setEditValor(e.target.value)}
                              placeholder="Valor" autoFocus
                              onKeyDown={e => { if (e.key === 'Enter') guardarEdicion(h.sku); if (e.key === 'Escape') setEditSku(null); }} />
                            <input className="form-control" type="date" style={{ width: 140, fontSize: 12 }}
                              value={editFecha} onChange={e => setEditFecha(e.target.value)} />
                          </div>
                        ) : (
                          <>
                            {h.valor_unitario != null ? formatMoney(h.valor_unitario) : <span style={{ color: 'var(--gray)' }}>sin valor</span>}
                            {h.origen_valor === 'referencial' && (
                              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }} title="No tiene valor de adquisición cargado; se usa el precio del proveedor principal">
                                precio referencial
                              </div>
                            )}
                            {h.fecha_adquisicion && (
                              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>adq. {h.fecha_adquisicion}</div>
                            )}
                          </>
                        )}
                      </td>
                    )}
                    {verValores && (
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>
                        {h.valor_unitario != null ? formatMoney(h.valor_total) : '—'}
                      </td>
                    )}
                    <td style={{ fontSize: 12, color: 'var(--gray)' }}>
                      {h.prestados > 0
                        ? (h.prestamos || []).map(p => p.empleado || (p.empleado_rut ? 'Empleado sin nombre' : p.area)).join(', ')
                        : '—'}
                    </td>
                    {verValores && puedeEditar && (
                      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {editando ? (
                          <>
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => guardarEdicion(h.sku)}>Guardar</button>
                            <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                              onClick={() => setEditSku(null)}>Cancelar</button>
                          </>
                        ) : (
                          <button className="btn btn-ghost" style={{ padding: '2px 8px', fontSize: 11 }}
                            title="Cargar el valor y la fecha de adquisición"
                            onClick={() => abrirEdicion(h)}>Editar valor</button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
              {/* Fila de totales */}
              {datos && lista.length > 0 && (
                <tr style={{ fontWeight: 700, borderTop: '2px solid var(--border)' }}>
                  <td colSpan={3}>Total ({lista.length} herramienta(s))</td>
                  <td style={{ textAlign: 'right' }}>{resumen.stock_total}</td>
                  <td />
                  {verValores && <td />}
                  {verValores && <td style={{ textAlign: 'right' }}>{formatMoney(resumen.valor_total || 0)}</td>}
                  <td>{resumen.prestadas || 0}</td>
                  {verValores && puedeEditar && <td />}
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination {...pag} />
      </div>
      </>
      )}
    </>
  );
}
