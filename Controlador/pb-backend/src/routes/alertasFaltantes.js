const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/alertasFaltantesController');
const especiales = require('../controllers/insumosEspecialesController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

router.use(authMiddleware);

// CU-124: el actor que vincula recepciones es JOP (y gerencia)
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.get('/',                   ctrl.listar);
router.post('/generar',           ctrl.generar);
// CU-122/124: rutas fijas antes de /:id. Comprar y reemplazar: gerencia; ver y vincular: también jop
router.get('/insumos-especiales',                  soloGerenciaOJop, especiales.listar);
router.post('/insumos-especiales/revisar',         soloGerenciaOJop, especiales.revisar);
router.post('/insumos-especiales/vincular',        soloGerenciaOJop, especiales.vincular);     // CU-124
router.get('/insumos-especiales/:id/lotes',        soloGerenciaOJop, especiales.lotesLibres);  // CU-124
router.post('/insumos-especiales/:id/reemplazar',  soloGerencia, especiales.reemplazar);   // CU-122 Exc 1
router.get('/:id',                ctrl.obtener);
router.put('/:id/solicitud',      ctrl.emitirSolicitud);
router.put('/:id/resolver',       ctrl.resolver);

module.exports = router;
