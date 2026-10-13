require('dotenv').config();
// C-05: hora de Chile aunque el servidor corra en UTC (AWS). Antes de crear cualquier fecha.
process.env.TZ = process.env.TZ || 'America/Santiago';
const express = require('express');
const cors    = require('cors');
const { pool, query } = require('./db/pool');

/* ── Rutas ── */
const authRoutes             = require('./routes/auth');
const materialRoutes         = require('./routes/materiales');
const bodegaRoutes           = require('./routes/bodegas');
const movimientoRoutes       = require('./routes/movimientos');
const proveedorRoutes        = require('./routes/proveedores');
const reporteRoutes          = require('./routes/reportes');
const usuarioRoutes          = require('./routes/usuarios');
const pedidoRoutes           = require('./routes/pedidos');
const alertaRoutes           = require('./routes/alertas');
const auditoriaRoutes        = require('./routes/auditoria');
// — Incremento 2 —
const facturaRoutes          = require('./routes/facturas');
const notificacionRoutes     = require('./routes/notificaciones');
const reservaRoutes          = require('./routes/reservas');
const alertaFaltanteRoutes   = require('./routes/alertasFaltantes');
const ordenTrabajoRoutes     = require('./routes/ordenesTrabajoRoutes');
const herramientaRoutes      = require('./routes/herramientas');
const recetaRoutes           = require('./routes/recetas');
const seguimientoPinturaRoutes = require('./routes/seguimientoPinturas');
// — Incremento 3 + 4 —
const codigoRoutes           = require('./routes/codigos');
const conteoRoutes           = require('./routes/conteos');
const integracionRoutes      = require('./routes/integracion');
const pedidoVentaRoutes      = require('./routes/pedidosVenta');
// — Fase de cierre —
const catalogoRoutes         = require('./routes/catalogos');

const app  = express();
const PORT = process.env.PORT || 3000;

// S-10 (F-02): detrás de nginx la IP real del usuario llega en X-Forwarded-For (la usan el límite de
// intentos del login y el antispam de recuperación). Solo con TRUST_PROXY=1: sin un proxy delante,
// ese encabezado se podría falsificar.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ── Middlewares globales ─────────────────────────────── */
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
}));
app.use(express.json());
// S-05 (F-02): cabeceras de seguridad de la API. Las de la página (CSP, HSTS) las pone nginx:
// docs/fase-cierre/despliegue.md. Una ruta puede cambiar Cache-Control con res.set().
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

/* ── Rutas ───────────────────────────────────────────── */
// Incremento 1
app.use('/api/auth',              authRoutes);
app.use('/api/materiales',        materialRoutes);
app.use('/api/herramientas',      herramientaRoutes);
app.use('/api/seguimiento-pinturas', seguimientoPinturaRoutes);
app.use('/api/recetas',           recetaRoutes);
app.use('/api/bodegas',           bodegaRoutes);
app.use('/api/movimientos',       movimientoRoutes);
app.use('/api/proveedores',       proveedorRoutes);
app.use('/api/reportes',          reporteRoutes);
app.use('/api/usuarios',          usuarioRoutes);
app.use('/api/pedidos',           pedidoRoutes);
app.use('/api/alertas',           alertaRoutes);
app.use('/api/auditoria',         auditoriaRoutes);

// Incremento 2
app.use('/api/facturas',          facturaRoutes);
app.use('/api/notificaciones',    notificacionRoutes);
app.use('/api/reservas',          reservaRoutes);
app.use('/api/alertas-faltantes', alertaFaltanteRoutes);
app.use('/api/ordenes-trabajo',   ordenTrabajoRoutes);

// Incremento 3 + 4
app.use('/api/codigos',           codigoRoutes);   // CU-30
app.use('/api/conteos',           conteoRoutes);   // CU-37
app.use('/api/integracion',       integracionRoutes); // CU-108
app.use('/api/pedidos-venta',     pedidoVentaRoutes); // CU-120 → 119: pedidos de instalación

// Fase de cierre
app.use('/api/catalogos',         catalogoRoutes);    // F-04: áreas, unidades y motivos

/* ── Health check ────────────────────────────────────── */
// C-09: mira también la BD, para que un monitor externo vea la caída real (503)
app.get('/api/health', async (req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'sin conexión', detalle: err.message });
  }
});

/* ── 404 ─────────────────────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

/* ── Error handler global ────────────────────────────── */
// Express identifica el manejador de errores por su ARIDAD (4 parámetros), así
// que `_next` tiene que quedar aunque no se use.
app.use((err, req, res, _next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

/* ── Arrancar servidor ───────────────────────────────── */
// Solo se levanta el servidor cuando este archivo se ejecuta directamente
// (npm run dev / npm start). Al hacer require() desde los tests, se exporta la
// app sin escuchar en ningun puerto, para que cada test la levante en uno libre.
if (require.main === module) {
  const servidor = app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  });

  // CU-122 (D17): revisión de ventas con insumos especiales al arrancar y cada 5 min.
  // Dentro de este if para que no corra en los tests.
  const { revisarVentas } = require('./controllers/insumosEspecialesController');
  const revisarInsumosEspeciales = () => revisarVentas()
    .then(r => { if (r.nuevas + r.actualizadas + r.descartadas > 0) console.log('[insumos especiales]', r); })
    .catch(e => console.warn('[insumos especiales] revisión fallida:', e.message));
  revisarInsumosEspeciales();
  const timerInsumos = setInterval(revisarInsumosEspeciales, 5 * 60 * 1000);

  // B-04: activaciones y desactivaciones programadas de cuentas, al arrancar y cada minuto.
  const { aplicarProgramaciones } = require('./controllers/usuariosController');
  const revisarProgramaciones = () => aplicarProgramaciones()
    .then(r => { if (r.procesadas > 0) console.log('[programaciones de cuentas]', r); })
    .catch(e => console.warn('[programaciones de cuentas] revisión fallida:', e.message));
  revisarProgramaciones();
  const timerProgramaciones = setInterval(revisarProgramaciones, 60 * 1000);

  // C-07: Express 4 no captura los errores de funciones async. Una promesa rechazada sin
  // manejar terminaría el proceso (Node 15+): se registra y el servidor sigue atendiendo.
  process.on('unhandledRejection', (motivo) => {
    console.error('❌ Promesa rechazada sin manejar:', motivo);
  });

  // C-08: cierre ordenado (despliegue, reinicio del servicio, Ctrl+C). Se dejan de aceptar
  // peticiones, se esperan las que están en curso y se cierra el pool.
  let cerrando = false;
  const cerrar = (senal) => {
    if (cerrando) return;
    cerrando = true;
    console.log(`\n${senal}: cerrando el servidor…`);
    clearInterval(timerInsumos);
    clearInterval(timerProgramaciones);
    servidor.close(async () => {
      await pool.end().catch(() => {});
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref(); // si algo se cuelga, no esperar más
  };
  process.on('SIGTERM', () => cerrar('SIGTERM'));
  process.on('SIGINT',  () => cerrar('SIGINT'));
}

module.exports = app;
