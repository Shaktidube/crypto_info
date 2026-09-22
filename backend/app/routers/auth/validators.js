const { body, param } = require('express-validator');

const validators = {};

// ─── Admin Validators ─────────────────────────────────────────────────────────

validators.adminLogin = [
    body('sEmail').not().isEmpty().bail().isEmail(),
    body('sPassword').not().isEmpty(),
];

validators.passwordResetPost = [
    body('sPassword')
        .not()
        .isEmpty()
        .bail()
        .matches(
            /^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).{8,15}$/
        ),
    body('sConfirmPassword')
        .not()
        .isEmpty()
        .bail()
        .custom((value, { req }) => value === req.body.sPassword),
    param('token').not().isEmpty(),
];

// ─── User Validators ──────────────────────────────────────────────────────────

validators.sendOTP = [
    body('sEmail').not().isEmpty().bail().isEmail(),
    body('sDeviceId').optional().isString().isLength({ min: 8, max: 128 }),
    body('bForceOtp').optional().isBoolean().toBoolean(),
];

validators.verifyOTP = [
    body('sEmail').not().isEmpty().bail().isEmail(),
    body('sOtp')
        .not()
        .isEmpty()
        .bail()
        .isLength({ min: 6, max: 6 })
        .isNumeric(),
    body('bRememberDevice').optional().isBoolean().toBoolean(),
    body('sDeviceId').optional().isString().isLength({ min: 8, max: 128 }),
];

validators.updateProfile = [
    body('sUsername')
        .not()
        .isEmpty()
        .withMessage('Username is required')
        .bail()
        .isLength({ min: 3, max: 20 })
        .withMessage('Username must be between 3 and 20 characters')
        .matches(/^[a-zA-Z0-9_ ]+$/)
        .withMessage('Only letters, numbers, spaces and underscores allowed'),
    body('sBio')
        .optional()
        .isLength({ max: 200 })
        .withMessage('Bio must be at most 200 characters'),
];

validators.googleAuth = [
    body('sIdToken').not().isEmpty(),
];

module.exports = validators;
