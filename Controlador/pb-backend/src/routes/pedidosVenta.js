const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/pedidosVentaController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

// Pedidos de instalación (CU-120 → 119): actores Gerencia y JOP (los dos CU)
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.use(authMiddleware, soloGerenciaOJop);

router.get('/',                 ctrl.listar);     // CU-120
router.get('/empleados',        ctrl.empleados);  // CU-125 (ruta fija antes de /:id)
router.get('/trazabilidad',     ctrl.trazabilidad);   // CU-121 (ruta fija antes de /:id)
router.get('/:id',              ctrl.obtener);    // CU-120 (Exc 1 y 3)
router.put('/:id/vinculacion',  ctrl.vincular);   // CU-120
router.put('/:id/preparado',    ctrl.marcarPreparado);   // CU-119
router.put('/:id/retiro/:sku',            ctrl.registrarRetiro);    // CU-126
router.post('/:id/retiro/:sku/ubicacion', ctrl.reportarUbicacion);  // CU-126 Exc 1
router.post('/:id/carga',                 ctrl.iniciarCarga);       // CU-125
router.put('/:id/salida',                 ctrl.confirmarSalida);    // CU-127
router.put('/:id/devolucion/:sku',        ctrl.devolverABodega);    // D51: lo retirado vuelve al anaquel
router.put('/:id/deshacer-preparado', soloGerencia, ctrl.deshacerPreparado);   // D51
router.put('/:id/cancelar',           soloGerencia, ctrl.cancelarPedido);      // D51: venta cancelada

module.exports = router;
