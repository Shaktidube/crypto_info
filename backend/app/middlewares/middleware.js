const { Admin, User } = require('../models');
const { validationResult } = require('express-validator');

const validateAdmin = async (req, res, next) => {
    try {
        if (!req.headers.authorization)
            return res.reply(messages.unauthorized());

        let token = req.headers.authorization;
        token = token.replace('Bearer ', '');

        let admin;

        try {
            admin = await Admin.findByToken(token);
        } catch (error) {
            return res.reply(messages.unauthorized());
        }

        if (!admin) {
            return res.reply(messages.unauthorized());
        }

        req.userId = admin._id;
        req.sEmail = admin.sEmail;
        
        /* express validators passed in middleware
            Empty field errors will be reverted from middleware no need to check in controllers
        */

        const errors = validationResult(req);

        if (!errors.isEmpty()) {
            return res.reply(messages.unprocessable_entity(), {
                errors: errors.array(),
            });
        }

        return next(null, null);
    } catch (error) {
        return _.catchServerError('middleware.validateAdmin', error, res);
    }
};

const validateUser = async (req, res, next) => {
    try {
        if (!req.headers.authorization) {
            return res.reply(messages.unauthorized());
        }

        let token = req.headers.authorization;
        token = token.replace('Bearer ', '');

        let user;

        try {
            user = await User.findByToken(token);
        } catch (error) {
            return res.reply(messages.unauthorized());
        }

        if (!user) {
            return res.reply(messages.unauthorized());
        }

        req.userId = user._id;
        req.authToken = token;

        /* express validators passed in middleware
            Empty field errors will be reverted from middleware no need to check in controllers
        */
       
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(messages.unprocessable_entity(), {
                errors: errors.array(),
            });
        }

        return next(null, null);
    } catch (error) {
        return _.catchServerError('middleware.validateUser', error, res);
    }
};

module.exports = {
    validateAdmin,
    validateUser,
};
