const express = require('express');
const router  = express.Router();
const ctrl    = require('../controllers/facturasController');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/',                    ctrl.listar);
router.get('/buscar-numero/:numero', ctrl.buscarPorNumero);
router.get('/:id',                 ctrl.obtener);
router.post('/',                   ctrl.crear);

module.exports = router;
