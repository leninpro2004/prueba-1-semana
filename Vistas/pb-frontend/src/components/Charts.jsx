/**
 * Gráficos en SVG — OPUS-12 (Req #4).
 *
 * Hechos a mano y sin dependencias: el proyecto solo tiene react, react-dom y
 * react-router-dom como dependencias de runtime, y traer una librería de
 * gráficos completa para tres gráficos de un reporte no se justifica. El SVG
 * además permite exportar la imagen sin plugins (ver descargarGrafico).
 *
 * Los colores son literales y no variables CSS a propósito: al serializar el
 * SVG para exportarlo, las variables CSS no se resuelven y saldría todo negro.
 */

export const PALETA = ['#e8833a', '#2d7dd2', '#5cb85c', '#c9526b', '#8e6fc9', '#3aa9a0', '#d4a72c', '#7a7a7a'];

const ejeY = (v, max) => (max > 0 ? (v / max) * 100 : 0);

/** Texto recortado para que no se desborde del área de etiquetas. */
const corta = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

/**
 * Escala "bonita": lleva el máximo al siguiente múltiplo de 1, 2 o 5 × 10^n y
 * devuelve los cortes del eje. Sin esto el eje se divide en cuartos del máximo
 * real y quedan marcas como $164k / $328k / $493k, que no se leen de un vistazo.
 */
export function escalaBonita(max, pasos = 4) {
  if (!(max > 0)) return { max: 1, ticks: [0] };
  const bruto = max / pasos;
  const mag = Math.pow(10, Math.floor(Math.log10(bruto)));
  const norm = bruto / mag;
  const paso = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const tope = Math.ceil(max / paso) * paso;
  const ticks = [];
  for (let v = 0; v <= tope + paso * 1e-9; v += paso) ticks.push(Math.round(v * 1e6) / 1e6);
  return { max: tope, ticks };
}

/**
 * Convierte un <svg> en PNG (data URL) sobre fondo blanco, al doble de tamaño para
 * que no se vea pixelado. Resuelve { dataUrl, ancho, alto } (ancho/alto del viewBox).
 * La usan la descarga de imagen y la exportación a PDF.
 */
export function svgAPng(svgEl) {
  return new Promise((resolve, reject) => {
    if (!svgEl) { reject(new Error('No hay gráfico para convertir')); return; }
    const ancho = svgEl.viewBox.baseVal.width || svgEl.clientWidth || 800;
    const alto  = svgEl.viewBox.baseVal.height || svgEl.clientHeight || 400;
    const escala = 2;

    const xml = new XMLSerializer().serializeToString(svgEl);
    const svg64 = 'data:image/svg+xml;base64,' + window.btoa(unescape(encodeURIComponent(xml)));

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = ancho * escala;
      canvas.height = alto * escala;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ dataUrl: canvas.toDataURL('image/png'), ancho, alto });
    };
    img.onerror = () => reject(new Error('No se pudo convertir el gráfico a imagen'));
    img.src = svg64;
  });
}

/**
 * Descarga un <svg> como PNG. Recibe el elemento (vía ref) y el nombre base.
 * Se dibuja sobre fondo blanco para que sirva en un informe impreso.
 */
export function descargarGrafico(svgEl, nombre) {
  if (!svgEl) return;
  svgAPng(svgEl).then(({ dataUrl }) => {
    // Fecha LOCAL: toISOString() da UTC y de tarde en Chile nombraría el archivo
    // con el día siguiente
    const f = new Date();
    const fecha = `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `${nombre}-${fecha}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }).catch(e => console.warn(e.message));
}

/** Leyenda compartida por los gráficos de varias series. */
function Leyenda({ series, x = 0, y = 0 }) {
  return (
    <g transform={`translate(${x},${y})`}>
      {series.map((s, i) => (
        <g key={s.label} transform={`translate(${i * 165},0)`}>
          <rect width="10" height="10" rx="2" fill={PALETA[i % PALETA.length]} />
          <text x="15" y="9" fontSize="11" fill="#555">{corta(s.label, 20)}</text>
        </g>
      ))}
    </g>
  );
}

/**
 * Barras horizontales — una fila por ítem. Buena para comparar pocas categorías
 * con nombres largos (las áreas de trabajo).
 */
export function BarrasHorizontales({ datos, formato = v => v, svgRef, alturaFila = 32 }) {
  const ANCHO = 800;
  const MARGEN_IZQ = 175;
  const MARGEN_DER = 95;
  const alto = Math.max(datos.length * alturaFila + 24, 80);
  const max = Math.max(...datos.map(d => d.valor), 0);
  const anchoUtil = ANCHO - MARGEN_IZQ - MARGEN_DER;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${ANCHO} ${alto}`} width="100%" height={alto}
      xmlns="http://www.w3.org/2000/svg" style={{ maxWidth: '100%' }} role="img">
      <rect width={ANCHO} height={alto} fill="#ffffff" />
      {datos.map((d, i) => {
        const y = i * alturaFila + 12;
        const w = max > 0 ? (d.valor / max) * anchoUtil : 0;
        return (
          <g key={d.label}>
            <text x={MARGEN_IZQ - 8} y={y + 14} fontSize="12" fill="#333" textAnchor="end">{corta(d.label, 24)}</text>
            <rect x={MARGEN_IZQ} y={y} width={Math.max(w, 1)} height={alturaFila - 12} rx="3"
              fill={d.color || PALETA[i % PALETA.length]} />
            <text x={MARGEN_IZQ + w + 6} y={y + 14} fontSize="11" fill="#555">{formato(d.valor)}</text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Barras verticales agrupadas — un grupo por etiqueta, una barra por serie.
 * Para el top de materiales desglosado por área.
 */
export function BarrasAgrupadas({ labels, series, formato = v => v, svgRef }) {
  const ANCHO = 800, ALTO = 340;
  const MARGEN = { top: 34, der: 12, abajo: 74, izq: 62 };
  const anchoUtil = ANCHO - MARGEN.izq - MARGEN.der;
  const altoUtil  = ALTO - MARGEN.top - MARGEN.abajo;

  const { max, ticks } = escalaBonita(Math.max(...series.flatMap(s => s.data), 0));
  const anchoGrupo = labels.length > 0 ? anchoUtil / labels.length : anchoUtil;
  const anchoBarra = series.length > 0 ? Math.min((anchoGrupo - 8) / series.length, 28) : 0;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${ANCHO} ${ALTO}`} width="100%" height={ALTO}
      xmlns="http://www.w3.org/2000/svg" style={{ maxWidth: '100%' }} role="img">
      <rect width={ANCHO} height={ALTO} fill="#ffffff" />
      <Leyenda series={series} x={MARGEN.izq} y={8} />

      {/* Grilla y escala */}
      {ticks.map(t => {
        const y = MARGEN.top + altoUtil - ejeY(t, max) / 100 * altoUtil;
        return (
          <g key={t}>
            <line x1={MARGEN.izq} y1={y} x2={ANCHO - MARGEN.der} y2={y} stroke="#e6e6e6" strokeWidth="1" />
            <text x={MARGEN.izq - 6} y={y + 4} fontSize="10" fill="#999" textAnchor="end">{formato(t)}</text>
          </g>
        );
      })}

      {labels.map((label, gi) => {
        const xGrupo = MARGEN.izq + gi * anchoGrupo;
        const offset = (anchoGrupo - anchoBarra * series.length) / 2;
        return (
          <g key={label}>
            {series.map((s, si) => {
              const v = s.data[gi] || 0;
              const h = max > 0 ? (v / max) * altoUtil : 0;
              return (
                <rect key={s.label} x={xGrupo + offset + si * anchoBarra} y={MARGEN.top + altoUtil - h}
                  width={Math.max(anchoBarra - 2, 1)} height={Math.max(h, v > 0 ? 1 : 0)} rx="2"
                  fill={PALETA[si % PALETA.length]}>
                  <title>{`${s.label} · ${label}: ${formato(v)}`}</title>
                </rect>
              );
            })}
            <text x={xGrupo + anchoGrupo / 2} y={MARGEN.top + altoUtil + 14} fontSize="10" fill="#666"
              textAnchor="end" transform={`rotate(-35 ${xGrupo + anchoGrupo / 2} ${MARGEN.top + altoUtil + 14})`}>
              {corta(label, 22)}
            </text>
          </g>
        );
      })}
      <line x1={MARGEN.izq} y1={MARGEN.top + altoUtil} x2={ANCHO - MARGEN.der} y2={MARGEN.top + altoUtil} stroke="#bbb" />
    </svg>
  );
}

/**
 * Serie temporal — una línea por área a lo largo de los meses.
 * Una serie con `punteada: true` se dibuja discontinua y sin puntos (p. ej. una
 * línea de tendencia, CU-75).
 */
export function LineaTemporal({ labels, series, formato = v => v, svgRef }) {
  const ANCHO = 800, ALTO = 320;
  const MARGEN = { top: 34, der: 16, abajo: 46, izq: 62 };
  const anchoUtil = ANCHO - MARGEN.izq - MARGEN.der;
  const altoUtil  = ALTO - MARGEN.top - MARGEN.abajo;

  const { max, ticks } = escalaBonita(Math.max(...series.flatMap(s => s.data), 0));
  const paso = labels.length > 1 ? anchoUtil / (labels.length - 1) : 0;
  const x = (i) => MARGEN.izq + (labels.length > 1 ? i * paso : anchoUtil / 2);
  const y = (v) => MARGEN.top + altoUtil - (ejeY(v, max) / 100) * altoUtil;

  return (
    <svg ref={svgRef} viewBox={`0 0 ${ANCHO} ${ALTO}`} width="100%" height={ALTO}
      xmlns="http://www.w3.org/2000/svg" style={{ maxWidth: '100%' }} role="img">
      <rect width={ANCHO} height={ALTO} fill="#ffffff" />
      <Leyenda series={series} x={MARGEN.izq} y={8} />

      {ticks.map(t => {
        const yy = MARGEN.top + altoUtil - (ejeY(t, max) / 100) * altoUtil;
        return (
          <g key={t}>
            <line x1={MARGEN.izq} y1={yy} x2={ANCHO - MARGEN.der} y2={yy} stroke="#e6e6e6" />
            <text x={MARGEN.izq - 6} y={yy + 4} fontSize="10" fill="#999" textAnchor="end">{formato(t)}</text>
          </g>
        );
      })}

      {series.map((s, si) => (
        <g key={s.label}>
          <polyline fill="none" stroke={PALETA[si % PALETA.length]} strokeWidth="2"
            strokeDasharray={s.punteada ? '6 4' : undefined}
            points={s.data.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
          {!s.punteada && s.data.map((v, i) => (
            <circle key={i} cx={x(i)} cy={y(v)} r="3" fill={PALETA[si % PALETA.length]}>
              <title>{`${s.label} · ${labels[i]}: ${formato(v)}`}</title>
            </circle>
          ))}
        </g>
      ))}

      {/* La primera y la última se anclan al borde: centradas se salen del viewBox */}
      {labels.map((l, i) => (
        <text key={l} x={x(i)} y={MARGEN.top + altoUtil + 16} fontSize="10" fill="#666"
          textAnchor={i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}>{l}</text>
      ))}
      <line x1={MARGEN.izq} y1={MARGEN.top + altoUtil} x2={ANCHO - MARGEN.der} y2={MARGEN.top + altoUtil} stroke="#bbb" />
    </svg>
  );
}
