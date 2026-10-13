import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';
import { usePageTitle } from '../../contexts/TitleContext';
import { formatMoney, formatMoneySigno, formatQty } from '../../utils/format';
import ReportesNav, { GRUPOS_REPORTES, reportesPara } from '../../components/ReportesNav';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre',
               'noviembre', 'diciembre'];

/**
 * B-08: índice de reportes (/reportes): una columna por tema; solo los que el rol puede abrir.
 * B-08b: debajo, los indicadores del mes en curso (GET /reportes/resumen). Cada uno lleva a su
 * reporte. Lo que el backend no envía (montos, o un reporte que el rol no ve) no se muestra.
 */
export default function ReportesIndice() {
  usePageTitle('Reportes');
  const { user } = useAuth();
  const permitidos = reportesPara(user);
  const [mes, setMes] = useState(null);

  useEffect(() => {
    API.reportes.resumen().then(setMes).catch(() => setMes(null));   // no es crítico: sin datos no se muestra
  }, []);

  // El período llega como 'YYYY-MM-DD' (fecha local del servidor): no pasar por Date
  const nombreMes = mes ? MESES[Number(mes.periodo.desde.slice(5, 7)) - 1] : '';

  return (
    <>
      <ReportesNav />
      <div className="page-header">
        <div>
          <div className="page-title">Reportes</div>
          <div className="page-subtitle">Elija un reporte. Cada uno se puede filtrar y exportar.</div>
        </div>
      </div>
      <div className="reportes-columnas">
      {GRUPOS_REPORTES.map(grupo => {
        const delGrupo = permitidos.filter(r => r.grupo === grupo);
        if (delGrupo.length === 0) return null;
        return (
          <section key={grupo}>
            <div className="reportes-grupo">{grupo}</div>
            <div className="reportes-grilla">
              {delGrupo.map(r => (
                <Link key={r.ruta} to={r.ruta} className="reporte-tarjeta">
                  <span className="reporte-icono">{r.icono}</span>
                  <span>
                    <span className="reporte-titulo">{r.titulo}</span>
                    <span className="reporte-descripcion">{r.descripcion}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
      </div>

      {mes && (
        <section style={{ marginTop: 28 }}>
          <div className="reportes-grupo">Este mes ({nombreMes})</div>
          <div className="kpi-grid" style={{ marginBottom: 0 }}>
            <Link to="/reportes/movimientos" className="kpi-card reporte-kpi">
              <div className="kpi-label">Movimientos</div>
              <div className="kpi-value">{formatQty(mes.movimientos.total)}</div>
              <div className="kpi-sub">
                {mes.movimientos.entradas} entradas · {mes.movimientos.salidas} salidas · {mes.movimientos.traslados} traslados
              </div>
            </Link>
            <Link to="/reportes/mermas" className="kpi-card kpi-warning reporte-kpi">
              <div className="kpi-label">Mermas</div>
              <div className="kpi-value">{formatQty(mes.mermas.eventos)}</div>
              <div className="kpi-sub">
                {'valor_clp' in mes.mermas ? <>{formatMoney(mes.mermas.valor_clp)} en pérdidas</> : 'registradas y aprobadas'}
              </div>
            </Link>
            {mes.desviaciones && (
              <Link to="/reportes/desviaciones" className="kpi-card kpi-danger reporte-kpi">
                <div className="kpi-label">Ítems con sobregasto</div>
                <div className="kpi-value">{formatQty(mes.desviaciones.items)}</div>
                <div className="kpi-sub">
                  {'impacto_clp' in mes.desviaciones
                    ? <><span style={{ color: mes.desviaciones.impacto_clp > 0 ? 'var(--danger)' : undefined }}>
                        {formatMoneySigno(-mes.desviaciones.impacto_clp)}</span> en {mes.desviaciones.ots} OT</>
                    : `en ${mes.desviaciones.ots} OT finalizadas`}
                </div>
              </Link>
            )}
            {mes.valor_inventario && (
              <Link to="/reportes/valorizacion" className="kpi-card kpi-success reporte-kpi">
                <div className="kpi-label">Valor del inventario</div>
                <div className="kpi-value" style={{ fontSize: 22 }}>{formatMoney(mes.valor_inventario.valor_clp)}</div>
                <div className="kpi-sub">
                  {mes.valor_inventario.sin_precio > 0
                    ? `${mes.valor_inventario.sin_precio} producto(s) sin precio no suman` : 'stock actual valorizado'}
                </div>
              </Link>
            )}
          </div>
        </section>
      )}
    </>
  );
}
