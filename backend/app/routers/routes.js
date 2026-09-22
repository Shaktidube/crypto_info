const router = require('express').Router();

router.use('/', [
    require('./admin/routes'),
    require('./auth/routes'),
    require('./user/routes'),
]);

module.exports = router;
