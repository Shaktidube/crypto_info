const { Admin, User } = require('../../models');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const otpGenerator = require('otp-generator');
const axios = require('axios');
const { nodemailer, globalCache, aws } = require('../../utils');
const {
    canSkipOtpForDevice,
    getTrustedDevice,
    registerTrustedDevice,
    removeTrustedDevice,
    touchTrustedDevice,
    hashDeviceId,
} = require('../../utils/lib/trustedDevice');
const { validationResult } = require('express-validator');
const config = require('../../../config/config');

const saltRounds = 10;

const controllers = {};

// ─── JWT Helpers ──────────────────────────────────────────────────────────────

const signJWT = function (user) {
    return jwt.sign(
        {
            _id: user._id,
            sName: user.sUserName,
            sEmail: user.sEmail,
            eAdminType: user.eAdminType,
        },
        config.JWT_SECRET,
        { expiresIn: config.JWT_VALIDITY }
    );
};

const signJWTForUser = function (user, options = {}) {
    const trusted = options.trusted === true;
    const expiresIn = trusted
        ? `${config.TRUSTED_DEVICE_SESSION_DAYS}d`
        : config.JWT_VALIDITY_SHORT;
    return jwt.sign(
        {
            _id: user._id,
            sEmail: user.sEmail,
            // Unique per login so phone + desktop never share one JWT string.
            jti: crypto.randomBytes(16).toString('hex'),
        },
        config.JWT_SECRET,
        { expiresIn },
    );
};

function sessionDaysForResponse(trusted) {
    if (trusted) return config.TRUSTED_DEVICE_SESSION_DAYS;
    const short = String(config.JWT_VALIDITY_SHORT || '1d');
    const match = short.match(/^(\d+)d$/i);
    return match ? Number(match[1]) : 1;
}

async function issueUserSession(user, options = {}) {
    const trusted = options.trusted === true;
    const token = signJWTForUser(user, { trusted });
    const sessionDays = sessionDaysForResponse(trusted);
    const expiresAt = new Date(
        Date.now() + sessionDays * 24 * 60 * 60 * 1000,
    );

    await user.addSession(token, {
        expiresAt,
        sDeviceHash: options.sDeviceId
            ? hashDeviceId(options.sDeviceId)
            : null,
    });

    return {
        sToken: token,
        nSessionDays: sessionDays,
        bIsNewUser: !user.bIsProfileComplete,
        bIsProfileComplete: user.bIsProfileComplete,
        bIsKrakenConnected: user.bIsKrakenConnected,
    };
}

async function sendOtpEmailAndPersist(sEmail, user) {
    const cacheKey = `${sEmail}:sendOtp`;
    const hitCount = globalCache.get(cacheKey) || 0;
    if (hitCount >= config.MAXIMUM_LIMIT_RATE) {
        return { rateLimited: true };
    }
    globalCache.set(cacheKey, hitCount + 1, config.CACHE_TTL);

    const otp = otpGenerator.generate(6, {
        upperCaseAlphabets: false,
        lowerCaseAlphabets: false,
        specialChars: false,
    });

    const dOtpExpires = new Date(Date.now() + 10 * 60 * 1000);

    if (user) {
        user.sOtp = otp;
        user.dOtpExpires = dOtpExpires;
        await user.save();
    } else {
        await User.findOneAndUpdate(
            { sEmail },
            { sOtp: otp, dOtpExpires },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );
    }

    await nodemailer.send(
        'otp_mail.html',
        { SITE_NAME: config.SITE_NAME, OTP: otp },
        {
            from: config.SMTP_FROM,
            to: sEmail,
            subject: `Your OTP for ${config.SITE_NAME}`,
        },
    ).catch((err) => console.error('user.sendOTP.mail', err));

    return { rateLimited: false };
}

// ─── Admin Controllers ────────────────────────────────────────────────────────

controllers.adminlogin = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(),
                { errors: errors.array() }
            );
        }

        const oAdmin = await Admin.findOne({
            sEmail: req.body.sEmail,
            isDeleted: false,
        });
        if (!oAdmin) return res.reply(messages.not_found('admin'));

        const result = bcrypt.compareSync(
            req.body.sPassword,
            oAdmin.sHash
        );
        if (!result) {
            return res.reply(messages.invalid('Password is'));
        }

        const token = signJWT(oAdmin);
        await Admin.findByIdAndUpdate(oAdmin._id, { sToken: token });

        return res.reply(messages.successfully('Admin Login'), {
            sToken: token,
            _id: oAdmin._id,
            sUserName: oAdmin.sUserName,
            eAdminType: oAdmin.eAdminType,
            sProfilePicUrl: oAdmin.sProfilePicUrl,
            aPermissions: oAdmin.aPermissions,
        });
    } catch (error) {
        return _.catchServerError('auth.adminlogin', error, res);
    }
};

controllers.passwordReset = async (req, res) => {
    try {
        if (!req.body.sEmail) {
            return res.reply(messages.required_field('Email ID'));
        }

        const cacheKey = `${req.body.sEmail}:resetPassword`;
        const getCache = globalCache.get(cacheKey);

        if (getCache) {
            if (getCache + 1 > config.MAXIMUM_LIMIT_RATE) {
                return res.reply(messages.too_many_request());
            }
            globalCache.set(cacheKey, getCache + 1, config.CACHE_TTL);
        } else {
            globalCache.set(cacheKey, 1, config.CACHE_TTL);
        }

        const oAdmin = await Admin.findOne({ sEmail: req.body.sEmail });
        if (!oAdmin) return res.reply(messages.not_found('admin'));

        const randomHash = crypto.randomBytes(20).toString('hex');

        await Admin.findOneAndUpdate(
            { sEmail: oAdmin.sEmail },
            {
                sResetPasswordToken: randomHash,
                sResetPasswordExpires: Date.now() + 300000,
            }
        );

        try {
            await nodemailer.send(
                'forgot_password_mail.html',
                {
                    SITE_NAME: config.SITE_NAME,
                    USERNAME: oAdmin.sUserName,
                    ACTIVELINK:
                        `${config.WEB_URL}/reset-password?token=${randomHash}`,
                },
                {
                    from: config.SMTP_FROM,
                    to: oAdmin.sEmail,
                    subject: 'Forgot Password',
                }
            );
            return res.reply(messages.successfully('Email Sent'));
        } catch (err) {
            return res.reply(messages.error('Email Sent'));
        }
    } catch (error) {
        return _.catchServerError('auth.passwordReset', error, res);
    }
};

controllers.passwordResetGet = async (req, res) => {
    try {
        if (!req.params.token) {
            return res.reply(messages.not_found('Token'));
        }

        const admin = await Admin.findOne({
            sResetPasswordToken: req.params.token,
        });
        if (!admin || admin.sResetPasswordExpires < Date.now()) {
            return res.reply(messages.invalid('token expire'));
        }
        return res.reply(messages.no_prefix('token valid'));
    } catch (error) {
        return _.catchServerError('auth.passwordResetGet', error, res);
    }
};

controllers.passwordResetPost = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(),
                { errors: errors.array() }
            );
        }

        const admin = await Admin.findOne({
            sResetPasswordToken: req.params.token,
        });
        if (!admin || admin.sResetPasswordExpires < Date.now()) {
            return res.reply(messages.expired('Token'));
        }
        if (req.body.sConfirmPassword !== req.body.sPassword) {
            return res.reply(
                messages.bad_request('Password not matched')
            );
        }

        admin.sHash = bcrypt.hashSync(
            req.body.sConfirmPassword,
            saltRounds
        );
        admin.sResetPasswordToken = undefined;
        admin.sResetPasswordExpires = undefined;
        await admin.save();

        return res.reply(messages.updated('Password'));
    } catch (error) {
        return _.catchServerError('auth.passwordResetPost', error, res);
    }
};

controllers.logout = async (req, res) => {
    try {
        await Admin.findByIdAndUpdate(req.userId, { sToken: '' });
        return res.reply(
            messages.successfully('Logout'),
            { sToken: null }
        );
    } catch (error) {
        return _.catchServerError('auth.logout', error, res);
    }
};

// ─── User Controllers ─────────────────────────────────────────────────────────

// POST /auth/user/send-otp
// Body: { sEmail, sDeviceId?, bForceOtp? }
// Trusted device + recent activity → session without OTP; else sends OTP email.
controllers.sendOTP = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(),
                { errors: errors.array() },
            );
        }

        const { sEmail, sDeviceId, bForceOtp } = req.body;

        const user = await User.findOne({ sEmail });
        if (user?.isDeleted) {
            return res.reply(messages.bad_request('Your account has been deleted. Contact admin'));
        }
        if (user && !user.isActive) {
            return res.reply(messages.bad_request('Your account has been deactivated. Contact admin'));
        }

        const forceOtp = bForceOtp === true || bForceOtp === 'true';

        if (
            !forceOtp &&
            user &&
            user.bIsProfileComplete &&
            sDeviceId &&
            canSkipOtpForDevice(user, sDeviceId)
        ) {
            const device = getTrustedDevice(user, sDeviceId);
            touchTrustedDevice(device);
            const session = await issueUserSession(user, {
                trusted: true,
                sDeviceId,
            });
            return res.reply(messages.successfully('Signed in'), {
                bRequiresOtp: false,
                ...session,
            });
        }

        const otpResult = await sendOtpEmailAndPersist(sEmail, user);
        if (otpResult.rateLimited) {
            return res.reply(messages.too_many_request());
        }

        return res.reply(messages.successfully('OTP Sent'), {
            bRequiresOtp: true,
        });
    } catch (error) {
        return _.catchServerError('user.sendOTP', error, res);
    }
};

// POST /auth/user/verify-otp
// Body: { sEmail, sOtp, bRememberDevice?, sDeviceId? }
controllers.verifyOTP = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(),
                { errors: errors.array() },
            );
        }

        const {
            sEmail,
            sOtp,
            bRememberDevice,
            sDeviceId,
        } = req.body;

        const user = await User.findOne({ sEmail });
        if (!user) return res.reply(messages.not_found('User'));
        if (user.isDeleted) return res.reply(messages.bad_request('Your account has been deleted. Contact admin'));
        if (!user.isActive) return res.reply(messages.bad_request('Your account has been deactivated. Contact admin'));

        if (!user.sOtp || !user.dOtpExpires) {
            return res.reply(
                messages.bad_request('OTP not requested'),
            );
        }

        if (user.dOtpExpires < new Date()) {
            return res.reply(messages.expired('OTP'));
        }

        if (user.sOtp !== sOtp) {
            return res.reply(messages.invalid('OTP'));
        }

        user.sOtp = null;
        user.dOtpExpires = null;

        const rememberDevice =
            bRememberDevice === true ||
            bRememberDevice === 'true' ||
            bRememberDevice === 1 ||
            bRememberDevice === '1';

        if (rememberDevice && sDeviceId) {
            registerTrustedDevice(user, sDeviceId);
        }

        const session = await issueUserSession(user, {
            trusted: rememberDevice,
            sDeviceId,
        });

        return res.reply(messages.successfully('OTP Verified'), {
            bRequiresOtp: false,
            ...session,
        });
    } catch (error) {
        return _.catchServerError('user.verifyOTP', error, res);
    }
};

// POST /auth/user/profile  [Protected]
// Body: { sUsername, sBio }
controllers.updateProfile = async (req, res) =>{
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(), 
                { errors: errors.array() }
            );
        }

        const { sUsername, sBio } = req.body;

        const existingUsername = await User.findOne({
            sUsername,
            _id: { $ne: req.userId },
        });
        if (existingUsername) {
            return res.reply(messages.already_exists('Username'));
        }

        const updateFields = {
            sUsername,
            sBio: sBio || '',
            bIsProfileComplete: true,
        };

        if (req.file) {
            let uploadedToS3 = false;
            try {
                const profilePicUrl = await aws.uploadProfileImage(
                    req.file,
                    String(req.userId),
                    req
                );
                if (profilePicUrl) {
                    uploadedToS3 = aws.isS3Configured();
                    updateFields.sProfilePicUrl = profilePicUrl;
                }
            } catch (uploadErr) {
                const detail = uploadErr?.message || String(uploadErr);
                // eslint-disable-next-line no-console
                console.error('[user.updateProfile] image upload failed:', detail);
                return res.reply(messages.server_error(`Profile image upload failed — ${detail}`));
            } finally {
                aws.cleanupAfterProfileUpload({
                    file: req.file,
                    userId: String(req.userId),
                    uploadedToS3,
                });
            }
        }

        const updatedUser = await User.findByIdAndUpdate(
            req.userId,
            updateFields,
            { new: true }
        );

        return res.reply(messages.updated('Profile'), {
            _id: updatedUser._id,
            sEmail: updatedUser.sEmail,
            sUsername: updatedUser.sUsername,
            sBio: updatedUser.sBio,
            sProfilePicUrl: aws.formatProfilePicUrlForClient(
                updatedUser.sProfilePicUrl || '',
                updatedUser.dUpdatedAt
            ),
        });
    } catch (error) {
        return _.catchServerError('user.updateProfile', error, res);
    }
};

// POST /auth/user/google
// Body: { sIdToken }  — Google access token from client SDK
controllers.googleAuth = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.reply(
                messages.unprocessable_entity(),
                { errors: errors.array() }
            );
        }

        const { sIdToken } = req.body;

        let googleUser;
        try {
            const response = await axios.get(
                'https://www.googleapis.com/oauth2/v3/userinfo',
                { headers: { Authorization: `Bearer ${sIdToken}` } }
            );
            googleUser = response.data;
        } catch (err) {
            return res.reply(messages.invalid('Google token'));
        }

        const {
            sub: sGoogleId,
            email: sEmail,
            picture: sPicture,
        } = googleUser;

        let user = await User.findOne({
            $or: [{ sGoogleId }, { sEmail }],
        });

        if (user?.isDeleted) {
            return res.reply(messages.bad_request('Your account has been deleted. Contact admin'));
        }
        if (user && !user.isActive) {
            return res.reply(messages.bad_request('Your account has been deactivated. Contact admin'));
        }

        const bIsNewUser = !user;

        if (!user) {
            user = await User.create({
                sEmail,
                sGoogleId,
                sProfilePicUrl: sPicture || '',
                bIsProfileComplete: false,
            });
        } else {
            if (!user.sGoogleId) user.sGoogleId = sGoogleId;
            if (!user.sProfilePicUrl && sPicture) {
                user.sProfilePicUrl = sPicture;
            }
        }

        const session = await issueUserSession(user, { trusted: true });

        return res.reply(messages.successfully('Google Sign-in'), {
            bRequiresOtp: false,
            ...session,
            bIsNewUser,
            sEmail: user.sEmail,
        });
    } catch (error) {
        return _.catchServerError('user.googleAuth', error, res);
    }
};

// POST /auth/user/logout  [Protected]
// Body: { sDeviceId?, bForgetDevice? } — optional untrust for this browser
// Logs out THIS device only — other devices keep their sessions.
controllers.logoutUser = async (req, res) => {
    try {
        const { sDeviceId, bForgetDevice } = req.body || {};
        const forgetDevice =
            bForgetDevice === true ||
            bForgetDevice === 'true' ||
            bForgetDevice === 1 ||
            bForgetDevice === '1';

        const user = await User.findById(req.userId);
        if (user) {
            if (forgetDevice && sDeviceId) {
                removeTrustedDevice(user, sDeviceId);
            }
            if (req.authToken) {
                await user.removeSession(req.authToken);
            } else {
                // Fallback if middleware did not attach token.
                user.sToken = '';
                await user.save();
            }
        }

        return res.reply(
            messages.successfully('Logout'),
            { sToken: null },
        );
    } catch (error) {
        return _.catchServerError('user.logoutUser', error, res);
    }
};

// GET /callback
// Kraken redirects here after OAuth approval.
// Forwards the code or error to the frontend /kraken-callback page.
controllers.krakenOAuthRedirect = (req, res) => {
    const { code, error } = req.query;
    const errorDescription = req.query.error_description;
    const frontendBase = config.WEB_URL;

    if (error) {
        return res.redirect(
            `${frontendBase}/kraken-callback?error=${encodeURIComponent(errorDescription || error)}`
        );
    }

    if (!code) {
        return res.redirect(`${frontendBase}/kraken-callback?error=missing_code`);
    }

    return res.redirect(`${frontendBase}/kraken-callback?code=${code}`);
};

module.exports = controllers;
