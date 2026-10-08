import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import { usePageTitle } from '../contexts/TitleContext';
import { fechaLocal, hoyLocal } from '../utils/format';

const IconAlerta = ({ stroke }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="1.8"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
);

const prioCls = { urgente: 'badge-danger', alta: 'badge-warning', media: 'badge-gray' };
const prioDot = { urgente: 'dot-urgente',  alta: 'dot-alta',      media: 'dot-media' };
const tipoCls = (t = '') => t.toLowerCase().includes('entrada') ? 'badge-success'
                          : t.toLowerCase().includes('salida')  ? 'badge-danger' : 'badge-gray';

/**
 * Dashboard — conversión 1:1 de dashboard.html.
 * Los valores iniciales replican el markup estático del HTML hasta que carga la API.
 */
export default function Dashboard() {
  usePageTitle('Dashboard');
  const { user } = useAuth();
  const navigate = useNavigate();

  const [kpis, setKpis] = useState({ urgentes: 2, bajo: 1, productos: 5, movs: 3, riesgo: 1, totalAlertas: 3 });
  const [activas, setActivas] = useState(null);   // null = markup estático inicial
  const [ultimos, setUltimos] = useState(null);

  // CU-83.1/83.2: procesar programaciones diferidas (layout.js lo hacía solo en dashboard)
  useEffect(() => {
    API.usuarios.procesarProgramaciones().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelado = false;

    async function cargarDashboard() {
      try {
        // Cargar alertas, productos y movimientos en paralelo
        const [alertas, productos, movimientos] = await Promise.all([
          API.alertas.listar().catch(() => []),
          API.materiales.listar().catch(() => []),
          API.movimientos.listar({ desde: hoyLocal() }).catch(() => []),
        ]);
        if (cancelado) return;

        const listaAlertas = Array.isArray(alertas) ? alertas : [];
        const urgentes = listaAlertas.filter(a => a.prioridad === 'urgente' && a.estado === 'activa').length;
        const bajo     = listaAlertas.filter(a => a.prioridad !== 'urgente' && a.estado === 'activa').length;
        const total    = Array.isArray(productos) ? productos.filter(p => p.estado === 'activo').length : 0;
        const movsHoy  = Array.isArray(movimientos) ? movimientos.length : 0;

        setKpis(k => ({
          ...k, urgentes, bajo, productos: total, movs: movsHoy,
          totalAlertas: listaAlertas.filter(a => a.estado === 'activa').length,
        }));
        setActivas(listaAlertas.filter(a => a.estado === 'activa').slice(0, 3));
        setUltimos(Array.isArray(movimientos) ? movimientos.slice(0, 5) : []);

        // Pedidos en riesgo (solo gerencia)
        if (user?.rol === 'gerencia') {
          const pedidos = await API.pedidos.listar().catch(() => []);
          if (cancelado) return;
          const enRiesgo = Array.isArray(pedidos) ? pedidos.filter(p => parseInt(p.materiales_faltantes || 0) > 0).length : 0;
          setKpis(k => ({ ...k, riesgo: enRiesgo }));
        }
      } catch (err) {
        console.warn('Error cargando dashboard:', err.message);
      }
    }

    // Generar alertas y luego cargar dashboard
    API.alertas.generar().catch(() => {}).finally(() => { if (!cancelado) cargarDashboard(); });
    return () => { cancelado = true; };
  }, [user?.rol]);

  const fecha = new Date().toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <>
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle" id="dash-subtitle">
            {user ? `Bienvenido, ${user.nombre || user.username} · ${fecha}` : 'Bienvenido al sistema de inventario'}
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="kpi-grid">
        <div className="kpi-card kpi-danger">
          <div className="kpi-label">Alertas urgentes</div>
          <div className="kpi-value danger" id="kpi-urgentes">{kpis.urgentes}</div>
          <div className="kpi-sub">Requieren atención inmediata</div>
          <div className="kpi-icon" style={{ background: '#f8d7da' }}><IconAlerta stroke="#dc3545" /></div>
        </div>

        <div className="kpi-card kpi-warning">
          <div className="kpi-label">Stock bajo mínimo</div>
          <div className="kpi-value warning" id="kpi-bajo">{kpis.bajo}</div>
          <div className="kpi-sub">Productos bajo umbral mínimo</div>
          <div className="kpi-icon" style={{ background: '#fff4e6' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fe8f01" strokeWidth="1.8"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Productos registrados</div>
          <div className="kpi-value" id="kpi-productos">{kpis.productos}</div>
          <div className="kpi-sub">En catálogo activo</div>
          <div className="kpi-icon" style={{ background: '#fff4e6' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fe8f01" strokeWidth="1.8"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>
          </div>
        </div>

        <div className="kpi-card">
          <div className="kpi-label">Movimientos hoy</div>
          <div className="kpi-value" id="kpi-movs">{kpis.movs}</div>
          <div className="kpi-sub">Entradas y salidas registradas</div>
          <div className="kpi-icon" style={{ background: '#fff4e6' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="#fe8f01" strokeWidth="1.8"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 014-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 01-4 4H3"/></svg>
          </div>
        </div>

        {/* Solo gerencia (data-rol="gerencia") */}
        {user?.rol !== 'jop' && (
          <div className="kpi-card kpi-danger">
            <div className="kpi-label">Pedidos en riesgo</div>
            <div className="kpi-value danger" id="kpi-riesgo">{kpis.riesgo}</div>
            <div className="kpi-sub">Sin stock suficiente</div>
            <div className="kpi-icon" style={{ background: '#f8d7da' }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="#dc3545" strokeWidth="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>
            </div>
          </div>
        )}
      </div>

      {/* Dos columnas: alertas + últimos movimientos */}
      <div className="two-col">

        {/* Alertas activas */}
        <div className="card">
          <div className="card-title">
            Alertas activas
            <span className="badge badge-danger">{kpis.totalAlertas}</span>
          </div>

          <div id="alertas-list">
            {activas === null && (
              <>
                <FilaAlertaEstatica dot="dot-urgente" nombre="Cerradura seguridad triple" sub="Stock crítico · Stock actual: 4" badge="badge-danger" prio="urgente" borde />
                <FilaAlertaEstatica dot="dot-alta" nombre="Acero inoxidable placa 2mm" sub="Stock bajo mínimo · Stock actual: 35" badge="badge-warning" prio="alta" borde />
                <FilaAlertaEstatica dot="dot-media" nombre="Tornillo acero inox 5cm" sub="Tiempo reposición · Stock actual: 120" badge="badge-gray" prio="media" />
              </>
            )}
            {activas !== null && activas.length === 0 && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--gray)', fontSize: 13 }}>✅ Sin alertas activas</div>
            )}
            {activas !== null && activas.map((a, i) => (
              <div
                key={a.id ?? i}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', cursor: 'pointer',
                  ...(i < activas.length - 1 ? { borderBottom: '1px solid #f0f0f0' } : {}) }}
                onClick={() => navigate(`/alertas?detalle=${a.id}`)}
              >
                <div className={`priority-dot ${prioDot[a.prioridad] || 'dot-media'}`} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{a.producto || a.sku}</div>
                  <div style={{ fontSize: 11, color: 'var(--gray)' }}>{a.tipo || '—'} · Stock actual: {parseFloat(a.stock_actual || 0)}</div>
                </div>
                <span className={`badge ${prioCls[a.prioridad] || 'badge-gray'}`}>{a.prioridad || 'media'}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f0f0f0' }}>
            <Link to="/alertas" className="btn btn-ghost btn-sm">Ver todas las alertas</Link>
          </div>
        </div>

        {/* Últimos movimientos */}
        <div className="card">
          <div className="card-title">Últimos movimientos</div>

          <div id="movs-list">
            {ultimos === null && (
              <>
                <FilaMovEstatica icono="↓" bg="#d1e7dd" nombre="Acero inoxidable placa 2mm" sub="2025-05-20 · jgarcia" badge="badge-success" texto="+100" />
                <FilaMovEstatica icono="↑" bg="#f8d7da" nombre="Cerradura seguridad triple" sub="2025-05-21 · mlopez" badge="badge-danger" texto="-16" />
                <FilaMovEstatica icono="⇄" bg="#fff4e6" nombre="Taladro percutor 800W" sub="2025-05-25 · jgarcia" badge="badge-orange" texto="traslado" />
              </>
            )}
            {ultimos !== null && ultimos.length === 0 && (
              <div style={{ textAlign: 'center', padding: 20, color: 'var(--gray)', fontSize: 13 }}>Sin movimientos hoy</div>
            )}
            {ultimos !== null && ultimos.map((m, i) => (
              <div
                key={m.id ?? i}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0',
                  ...(i < ultimos.length - 1 ? { borderBottom: '1px solid #f0f0f0' } : {}) }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{m.material_nombre || m.sku}</div>
                  <div style={{ fontSize: 11, color: 'var(--gray)' }}>{fechaLocal(m.fecha_hora)} · {m.bodega || '—'}</div>
                </div>
                <span className={`badge ${tipoCls(m.tipo)}`}>{m.tipo || '—'}</span>
                <span style={{ fontSize: 12, fontWeight: 600, minWidth: 30, textAlign: 'right' }}>{parseFloat(m.cantidad || 0)}</span>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f0f0f0' }}>
            <Link to="/movimientos/historial" className="btn btn-ghost btn-sm">Ver historial completo</Link>
          </div>
        </div>

      </div>
    </>
  );
}

/* Filas estáticas del HTML original (se muestran hasta que responde la API) */
function FilaAlertaEstatica({ dot, nombre, sub, badge, prio, borde }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', ...(borde ? { borderBottom: '1px solid #f0f0f0' } : {}) }}>
      <div className={`priority-dot ${dot}`} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{nombre}</div>
        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{sub}</div>
      </div>
      <span className={`badge ${badge}`}>{prio}</span>
    </div>
  );
}

function FilaMovEstatica({ icono, bg, nombre, sub, badge, texto }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #f0f0f0' }}>
      <div style={{ width: 32, height: 32, borderRadius: 8, background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>{icono}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{nombre}</div>
        <div style={{ fontSize: 11, color: 'var(--gray)' }}>{sub}</div>
      </div>
      <span className={`badge ${badge}`}>{texto}</span>
    </div>
  );
}
