/**
 * Folder name should be same as model
 * All authentication APIs should be added to the 'auth' folder
 */
const router = require('express').Router();
const { validateAdmin } = require('../../middlewares/middleware');
const adminControllers = require('./controllers');
const v = require('./validators');

router.patch('/admin/password/update', validateAdmin, v.changePassword, adminControllers.changePassword);
router.get('/admin/profile', validateAdmin, adminControllers.profile);
router.patch('/admin/profile/update', validateAdmin, v.updateProfile, adminControllers.updateProfile);

// Dashboard
router.get('/admin/dashboard/stats', validateAdmin, adminControllers.dashboardStats);

// User Management
router.get('/admin/users/list', validateAdmin, v.userList, adminControllers.userList);
router.get('/admin/users/:id/detail', validateAdmin, v.userId, adminControllers.userDetail);
router.patch('/admin/users/:id/status', validateAdmin, v.userId, adminControllers.userToggleStatus);
router.delete('/admin/users/:id/delete', validateAdmin, v.userId, adminControllers.userDelete);

// Contact Inquiries
router.get('/admin/inquiries/list', validateAdmin, v.inquiryList, adminControllers.inquiryList);
router.patch('/admin/inquiries/:id/status', validateAdmin, v.updateInquiryStatus, adminControllers.updateInquiryStatus);
router.post('/admin/inquiries/:id/reply', validateAdmin, adminControllers.replyToInquiry);

// FAQs
router.get('/admin/faqs/list', validateAdmin, v.faqList, adminControllers.faqList);
router.post('/admin/faqs/create', validateAdmin, v.createFaq, adminControllers.createFaq);
router.patch('/admin/faqs/:id/update', validateAdmin, v.updateFaq, adminControllers.updateFaq);
router.delete('/admin/faqs/:id/delete', validateAdmin, v.deleteFaq, adminControllers.deleteFaq);

// CMS Management (no validation)
router.get('/admin/cms/list', validateAdmin, adminControllers.viewCms);
router.get('/admin/cms/:id', validateAdmin, adminControllers.getCms);
router.patch('/admin/cms/update', validateAdmin, adminControllers.updateCmsContent);

// Features
router.get('/admin/features/list', validateAdmin, adminControllers.featureList);
router.post('/admin/features/create', validateAdmin, adminControllers.createFeature);
router.patch('/admin/features/:id/update', validateAdmin, adminControllers.updateFeature);
router.delete('/admin/features/:id/delete', validateAdmin, adminControllers.deleteFeature);

// News Articles
router.get('/admin/news/list', validateAdmin, adminControllers.newsList);
router.post('/admin/news/create', validateAdmin, adminControllers.createNews);
router.patch('/admin/news/:id/update', validateAdmin, adminControllers.updateNews);
router.delete('/admin/news/:id/delete', validateAdmin, adminControllers.deleteNews);

// CoinDCX futures candle scanner
router.get('/admin/coindcx/scanner/status', validateAdmin, adminControllers.coindcxScannerStatus);
router.post('/admin/coindcx/scanner/start', validateAdmin, adminControllers.startCoindcxScanner);
router.post('/admin/coindcx/scanner/stop', validateAdmin, adminControllers.stopCoindcxScanner);
router.post('/admin/coindcx/scanner/scan-now', validateAdmin, adminControllers.scanCoindcxNow);
router.post('/admin/coindcx/scanner/test-email', validateAdmin, adminControllers.testCoindcxScannerEmail);
router.get('/admin/coindcx/alerts/list', validateAdmin, v.candleAlertList, adminControllers.coindcxAlertList);
router.get('/admin/coindcx/signals/latest', validateAdmin, adminControllers.coindcxLatestSignals);
router.get('/admin/coindcx/trading/verify', validateAdmin, adminControllers.coindcxVerifyCredentials);

module.exports = router;
