const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/recetasController');
const { authMiddleware, soloOperativo } = require('../middleware/auth');

router.use(authMiddleware);

// CU-102 (D37): crean, editan, duplican y activan recetas gerencia y jop. La regla
// de las 24 h (después solo gerencia, con motivo) la aplica el controller.
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

// Las rutas fijas van ANTES de las parametrizadas: /por-orden/:otId no debe
// caer en /:id (misma precaucion que en herramientas y seguimiento de pinturas).
router.get('/por-orden/:otId', ctrl.recetaPorOrden);
router.get('/',               ctrl.listar);
router.get('/:id',            ctrl.obtener);
router.get('/:id/sugerencia-duplicado', soloGerenciaOJop, ctrl.sugerenciaDuplicado);   // CU-102

router.post('/',                         soloGerenciaOJop, ctrl.crear);        // CU-102
router.post('/:id/duplicar',             soloGerenciaOJop, ctrl.duplicar);     // CU-102 Exc 2
router.put('/:id/estado',                soloGerenciaOJop, ctrl.cambiarEstado); // CU-102
router.put('/:id',                       soloGerenciaOJop, ctrl.actualizar);
router.post('/:id/cargar-en-ot/:otId',   soloOperativo,    ctrl.cargarEnOT);

module.exports = router;
