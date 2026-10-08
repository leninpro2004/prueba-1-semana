require('dotenv').config();
const express = require('express');
const cors    = require('cors');

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

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Middlewares globales ─────────────────────────────── */
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:5000', 'http://localhost:5173', 'http://127.0.0.1:5173'],
  credentials: true,
}));
app.use(express.json());

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

/* ── Health check ────────────────────────────────────── */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  app.listen(PORT, () => {
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
  setInterval(revisarInsumosEspeciales, 5 * 60 * 1000);
}

module.exports = app;
