const router = require('express').Router();
const bodyParser = require('body-parser');
const { validateUser } = require('../../middlewares/middleware');
const controllers = require('./controllers');

router.get('/public/passport/og-image/url', controllers.getPassportOgImageUrl);
// Raw PNG upload avoids the ~33% base64 inflation that pushed bodies past the
// reverse-proxy limit (413). JSON bodies still work via the global json parser.
router.post(
    '/public/passport/og-image',
    bodyParser.raw({ type: 'application/octet-stream', limit: '6mb' }),
    controllers.uploadPassportOgImage
);
router.get('/public/passport/:username', controllers.getPublicPassport);
router.get('/public/profile-pic/:filename', controllers.serveProfilePic);
router.get('/public/faqs', controllers.getPublicFaqs);
router.get('/public/features', controllers.getPublicFeatures);
router.get('/public/news', controllers.getPublicNews);
router.get('/public/cms/:slug', controllers.getPublicCms);
router.post('/public/contact', controllers.submitPublicContact);
router.get('/user/stats', validateUser, controllers.getStats);
router.get('/user/profile', validateUser, controllers.getProfile);
router.get('/user/kraken/status', validateUser, controllers.krakenStatus);
router.get('/user/dashboard', validateUser, controllers.getUserDashboardData);

router.post('/user/inquiries', validateUser, controllers.submitInquiry);
router.get('/user/inquiries', validateUser, controllers.getMyInquiries);

// Kraken OAuth
router.post('/auth/kraken/callback', validateUser, controllers.krakenCallback);

module.exports = router;
