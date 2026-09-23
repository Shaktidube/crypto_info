const router = require('express').Router();

router.use('/', [
    require('./admin/routes'),
    require('./auth/routes'),
    require('./user/routes'),
    require('./billing/routes'),
]);

module.exports = router;
