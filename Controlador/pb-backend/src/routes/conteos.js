const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/conteosController');
const { authMiddleware, soloOperativo, soloGerencia } = require('../middleware/auth');
const { requiereFirma } = require('../middleware/firma');

// CU-37: conteo ciclico (gerencia, administrador y jop)
router.use(authMiddleware, soloOperativo);

// Rutas fijas antes de /:id
router.get('/tolerancias',         soloGerencia, ctrl.obtenerTolerancias);    // D10 (sesion 4)
router.put('/tolerancias',         soloGerencia, requiereFirma('tolerancias'), ctrl.actualizarTolerancias);
router.get('/bodega/:id/preparar', ctrl.preparar);
router.get('/',                    ctrl.listar);
router.post('/',                   ctrl.crear);
router.get('/:id',                 ctrl.obtener);

// CU-43: la comparacion muestra el teorico → solo gerencia (el actor del CU)
router.get('/:id/diferencias',     soloGerencia, ctrl.diferencias);
router.post('/:id/procesar',       soloGerencia, requiereFirma('ajuste_conteo'), ctrl.procesar);
// D53: gerencia aprueba el ajuste del stock por las diferencias
router.post('/:id/ajustes',        soloGerencia, requiereFirma('ajuste_conteo'), ctrl.ajustar);

// CU-57: alertas por diferencia (gerencia y jop, los actores del CU)
router.post('/:id/alertas',        ctrl.generarAlertas);

module.exports = router;
