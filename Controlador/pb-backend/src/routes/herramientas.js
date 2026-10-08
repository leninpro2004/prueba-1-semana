const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/herramientasController');
const { authMiddleware, soloGerencia, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

// Rutas fijas ANTES de las parametrizadas
// OPUS-13
router.get('/reporte',                    ctrl.reporteValorizacion);
router.get('/catalogo',                   ctrl.catalogo);
router.get('/asignaciones',               ctrl.listarAsignaciones);
router.get('/mantenimientos',             ctrl.listarMantenimientos);
router.put('/asignaciones/:id/devolver',  soloOperativo, ctrl.devolverAsignacion);   // D62

// OPUS-10 (Req #5): listado con valorizacion. Los montos se ocultan al rol jop
// dentro del controller (mismo criterio que reporteMermas).
router.get('/', ctrl.listar);

// Marcar/desmarcar herramienta y cargar su valor de adquisicion
router.put('/:sku', soloGerencia, ctrl.actualizar);

// OPUS-13: depreciacion, asignaciones y mantenimiento
router.get('/:sku/depreciacion',  ctrl.calcularDepreciacion);
router.put('/:sku/depreciacion',  soloGerencia, ctrl.configurarDepreciacion);
router.post('/:sku/asignar',      soloOperativo, ctrl.asignar);          // D62
router.post('/:sku/mantenimiento', soloOperativo, ctrl.registrarMantenimiento);   // D62

module.exports = router;
