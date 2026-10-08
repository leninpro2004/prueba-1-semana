const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/reportesController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

const usrCtrl = require('../controllers/usuariosController');

router.use(authMiddleware);

// CU-71: el análisis de rotación lo usan gerencia y jop (no muestra montos)
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.get('/movimientos',          ctrl.reporteMovimientos);
router.get('/mermas',               ctrl.reporteMermas);
// Incremento 2
router.get('/valorizacion',         soloGerencia, ctrl.valorizacion);
router.get('/areas',                ctrl.listarAreas);
router.get('/consumo-area',         ctrl.consumoArea);
// OPUS-12 (Req #4): datos preprocesados para los graficos
router.get('/consumo-area/grafico', ctrl.consumoAreaGrafico);
router.get('/programacion-semanal', ctrl.programacionSemanal);
router.get('/rotacion',             soloGerenciaOJop, ctrl.rotacion);   // CU-71
router.get('/historico',            soloGerencia, ctrl.historico);      // CU-75: montos en CLP
router.get('/desviaciones',         soloGerenciaOJop, ctrl.desviaciones); // CU-104: jop sin montos, mismo orden
// CU-122 + CU-81.1 (exportar con detección de extracción masiva)
router.get('/programacion-semanal/exportar', usrCtrl.deteccionExtraccionMasiva, ctrl.exportarProgramacion);
router.get('/programacion-semanal/exportar-pdf', usrCtrl.deteccionExtraccionMasiva, ctrl.exportarProgramacionPDF);

module.exports = router;
