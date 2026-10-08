const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/reservasController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

// CU-131: actores Gerencia y JOP
function soloGerenciaOJop(req, res, next) {
  if (!['gerencia', 'jop'].includes(req.user?.rol)) {
    return res.status(403).json({ error: 'Acceso restringido a gerencia y jefatura de operaciones' });
  }
  next();
}

router.get('/',              ctrl.listar);
router.get('/ventas',        soloGerenciaOJop, ctrl.ventasReservables);   // CU-131 (rutas fijas antes de /:id)
router.get('/ventas/:id',    soloGerenciaOJop, ctrl.vistaReservaVenta);
router.post('/ventas/:id',   soloGerenciaOJop, ctrl.reservarVenta);
// CU-132: gestionar (liberar o anular) exige permisos de gestión de reservas → gerencia y jop
router.put('/:id/liberar',   soloGerenciaOJop, ctrl.liberar);
router.put('/:id/anular',    soloGerenciaOJop, ctrl.anular);

module.exports = router;
