const { body, query, param, validationResult } = require('express-validator');

const validators = {};

/* ── reply on first validation error ── */
const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return res.reply(messages.unprocessable_entity(first.msg));
    }
    return next();
};

/* ── reusable MongoDB ObjectId param rule ── */
const mongoId = (field = 'id') =>
    param(field).isMongoId().withMessage(`Invalid ${field}`);

/* ── reusable pagination query rules ── */
const paginationRules = [
    query('nPage').optional().isInt({ min: 1 }).withMessage('nPage must be a positive integer'),
    query('nLimit').optional().isInt({ min: 1, max: 50 }).withMessage('nLimit must be between 1 and 50'),
];

// ─── Profile ─────────────────────────────────────────────────────────────────

validators.updateProfile = [
    body('sUserName')
        .trim()
        .notEmpty().withMessage('User name is required')
        .isLength({ min: 3, max: 50 }).withMessage('User name must be between 3 and 50 characters'),
    validate,
];

// ─── Change Password ──────────────────────────────────────────────────────────

validators.changePassword = [
    body('sOldPassword')
        .trim()
        .notEmpty().withMessage('Old password is required')
        .isLength({ min: 8, max: 50 }).withMessage('Old password must be between 8 and 50 characters'),
    body('sNewPassword')
        .trim()
        .notEmpty().withMessage('New password is required')
        .isLength({ min: 8, max: 50 }).withMessage('New password must be between 8 and 50 characters'),
    body('sConfirmPassword')
        .trim()
        .notEmpty().withMessage('Confirm password is required')
        .isLength({ min: 8, max: 50 }).withMessage('Confirm password must be between 8 and 50 characters'),
    validate,
];

// ─── User Management ──────────────────────────────────────────────────────────

validators.userList = [
    query('sSearch').optional().trim().isLength({ max: 100 }).withMessage('Search term must not exceed 100 characters'),
    ...paginationRules,
    validate,
];

validators.userId = [mongoId('id'), validate];

// ─── Contact Inquiries ────────────────────────────────────────────────────────

validators.inquiryList = [
    query('sSearch').optional().trim().isLength({ max: 100 }).withMessage('Search term must not exceed 100 characters'),
    query('eStatus').optional({ values: 'falsy' }).isIn(['Pending', 'Closed']).withMessage('eStatus must be Pending or Closed'),
    ...paginationRules,
    validate,
];

validators.updateInquiryStatus = [
    mongoId('id'),
    body('eStatus')
        .notEmpty().withMessage('Status is required')
        .isIn(['Pending', 'Closed']).withMessage('eStatus must be Pending or Closed'),
    validate,
];

// ─── FAQs ─────────────────────────────────────────────────────────────────────

validators.faqList = [
    query('sSearch').optional().trim().isLength({ max: 100 }).withMessage('Search term must not exceed 100 characters'),
    ...paginationRules,
    validate,
];

validators.createFaq = [
    body('sQuestion')
        .trim()
        .notEmpty().withMessage('Question is required')
        .isLength({ min: 5, max: 500 }).withMessage('Question must be between 5 and 500 characters'),
    body('sAnswer')
        .trim()
        .notEmpty().withMessage('Answer is required')
        .isLength({ min: 5, max: 2000 }).withMessage('Answer must be between 5 and 2000 characters'),
    validate,
];

validators.updateFaq = [
    mongoId('id'),
    body('sQuestion')
        .trim()
        .notEmpty().withMessage('Question is required')
        .isLength({ min: 5, max: 500 }).withMessage('Question must be between 5 and 500 characters'),
    body('sAnswer')
        .trim()
        .notEmpty().withMessage('Answer is required')
        .isLength({ min: 5, max: 2000 }).withMessage('Answer must be between 5 and 2000 characters'),
    validate,
];

validators.deleteFaq = [mongoId('id'), validate];

validators.candleAlertList = [...paginationRules, validate];

module.exports = validators;
