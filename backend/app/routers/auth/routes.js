/*
    - The endpoint should start with the folder name, followed by the relevant entities or related information, and so on
    - Routes syntax router.method('/endpoint', validators, multer, controller)
    - Mention endpoint state at the end
        eg.
        - Data Table api end point router.get(<folder-name>/<admin/user>/list)
        - .patch api end point (/update) or (/edit) or (/add)
        - .delete api end point (/delete)
        - So on.... You got the idea :)
    - The ID should always be passed as a parameter to ensure that the necessary record is targeted for the operation
    - Use express-validator to check body values
*/

const router = require('express').Router();
const authController = require('./controllers');
const validators = require('./validators');
const { validateUser, validateAdmin } = require('../../middlewares/middleware');
const { uploader } = require('../../utils');

// ─── Admin Routes ─────────────────────────────────────────────────────────────
router.post('/auth/admin/login', validators.adminLogin, authController.adminlogin);
router.post('/auth/admin/password/reset', authController.passwordReset);
router.get('/auth/admin/:token/reset', authController.passwordResetGet);
router.post('/auth/admin/:token/reset', validators.passwordResetPost, authController.passwordResetPost);
router.post('/auth/admin/logout', validateAdmin, authController.logout);

// ─── User Routes ──────────────────────────────────────────────────────────────
// Step 1: Send OTP (register or login)
router.post('/auth/user/send-otp', validators.sendOTP, authController.sendOTP);

// Step 2: Verify OTP
router.post('/auth/user/verify-otp', validators.verifyOTP, authController.verifyOTP);

// Step 3: Set username & bio (protected — call after first login)
router.post(
    '/auth/user/profile',
    validateUser,
    uploader.uploadProfileImage(),
    validators.updateProfile,
    authController.updateProfile
);

// Google OAuth sign-in / sign-up
router.post('/auth/user/google', validators.googleAuth, authController.googleAuth);

// Logout
router.post('/auth/user/logout', validateUser, authController.logoutUser);

module.exports = router;
