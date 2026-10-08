const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/alertasController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// CU-47: la evaluación de cobertura la hacen gerencia y jop (decisión P8)
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.get('/tipos',         ctrl.listarTipos);
router.get('/reposicion',    soloGerenciaOJop, ctrl.listarReposicion);   // CU-48
router.get('/historial',     ctrl.historial);                            // CU-55
router.get('/',              ctrl.listar);
router.post('/generar',      ctrl.generar);
router.post('/reposicion/evaluar', soloGerenciaOJop, ctrl.evaluarReposicion);
router.put('/:id/resolver',  ctrl.resolver);

module.exports = router;
