const router = require('express').Router();
const controllers = require('./controllers');
const { validateUser } = require('../../middlewares/middleware');

router.get('/billing/plans', controllers.plans);
router.get('/billing/status', validateUser, controllers.status);
router.post(
    '/billing/checkout-session',
    validateUser,
    controllers.createCheckoutSession,
);
router.get(
    '/billing/checkout-session/:sessionId',
    validateUser,
    controllers.checkoutStatus,
);

module.exports = router;
