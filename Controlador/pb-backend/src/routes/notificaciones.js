const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/notificacionesController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',             ctrl.listar);
router.get('/resumen',      ctrl.resumen);
router.put('/leer-todas',   ctrl.marcarTodasLeidas);
router.put('/:id/leer',     ctrl.marcarLeida);

module.exports = router;
