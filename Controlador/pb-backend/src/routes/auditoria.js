const express = require('express');
const router  = express.Router();
const { listarAcciones } = require('../controllers/auditoriaController');
const { authMiddleware, soloGerencia } = require('../middleware/auth');

router.use(authMiddleware);
router.use(soloGerencia);

router.get('/acciones', listarAcciones);

module.exports = router;
