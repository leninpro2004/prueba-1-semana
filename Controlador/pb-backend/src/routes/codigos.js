const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/codigosController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

// CU-30: codigos de barras internos
router.use(authMiddleware);

router.post('/:sku/generar', soloGerencia, ctrl.generar);
router.get('/:valor',                      ctrl.resolver);

module.exports = router;
