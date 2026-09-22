const { Admin, User, ContactInquiry, Faq, Cms, Feature, NewsArticle, CandleAlert } = require('../../models/index');
const { nodemailer } = require('../../utils');
const config = require('../../../config/config');
const bcrypt = require('bcrypt');
const coindcxCandleScanner = require('../../services/coindcx/coindcxCandleScanner');
const { toLatestSignalView } = require('../../services/coindcx/alertPayload');

const saltRounds = 10;
const controllers = {};

controllers.profile = async (req, res) => {
    try {
        const oAdmin = await Admin.findById(req.userId).select('sEmail sProfilePicUrl sUserName eAdminType');

        return res.reply(messages.success('Data found'), oAdmin);
    } catch (error) {
        return _.catchServerError('admin.profile', error, res);
    }
};

controllers.updateProfile = async (req, res) => {
    try {
        if (!req.body.sUserName)
            return res.reply(messages.not_found('User Name'));

        if (_.isUserName(req.body.sUserName))
            return res.reply(messages.invalid('User Name'));

        const oProfileDetails = {
            sUserName: req.body.sUserName,
        };

        const oResponse = await Admin.findByIdAndUpdate(
            req.userId,
            oProfileDetails,
        );

        if (!oResponse) return res.reply(messages.not_found('user'));

        return res.reply(messages.updated('Admin Profile'));
    } catch (error) {
        return _.catchServerError('admin.updateProfile', error, res);
    }
};

// change password
controllers.changePassword = async (req, res) => {
    try {
        if (!req.body.sOldPassword) {
            return res.reply(messages.not_found('Old Password'));
        }
        if (!req.body.sNewPassword) {
            return res.reply(messages.not_found('New Password'));
        }
        if (!req.body.sConfirmPassword) {
            return res.reply(messages.not_found('Confirm Password'));
        }

        if (_.isPassword(req.body.sNewPassword))
            return res.reply(messages.invalid('New-Password'));
        if (_.isPassword(req.body.sConfirmPassword))
            return res.reply(messages.invalid('Confirm-Password'));

        const admin = await Admin.findById(req.userId);

        const result = bcrypt.compareSync(req.body.sOldPassword, admin.sHash);
        if (result) {
            if (req.body.sNewPassword == req.body.sOldPassword) {
                return res.reply(
                    messages.bad_request(
                        'Old password and new password is same'
                    )
                );
            }
            if (req.body.sConfirmPassword !== req.body.sNewPassword) {
                return res.reply(messages.bad_request('Password not matched'));
            }

            const hash = bcrypt.hashSync(req.body.sConfirmPassword, saltRounds);

            admin.sHash = hash;

            await Admin.findByIdAndUpdate(req.userId, {
                sHash: hash,
            });
            return res.reply(messages.updated('Password'));
        } else {
            return res.reply(messages.invalid('Password'));
        }
    } catch (error) {
        return _.catchServerError('admin.changePassword', error, res);
    }
};

// ─── Dashboard Stats ───────────────────────────────────────────────────────
controllers.dashboardStats = async (req, res) => {
    try {
        const [nTotalUsers, nActiveTRPs,
            nTotalInquiries, nTotalFaqs, aRecentInquiries]
            = await Promise.all([
                User.countDocuments({ }),
                // Count users who have a saved passport (real trading stats stored)
                User.countDocuments({
                    'oPassportStats.dLastUpdated': { $ne: null },
                }),
                ContactInquiry.countDocuments(),
                Faq.countDocuments(),
                ContactInquiry.find().sort({ dCreatedAt: -1 }).limit(5)
                    .select('sName sEmail sMessage eStatus dCreatedAt'),
            ]);
        return res.reply(messages.success('Dashboard stats'),
            {
                nTotalUsers,
                nActiveTRPs,
                nTotalInquiries,
                nTotalFaqs,
                aRecentInquiries
            });
    } catch (error) {
        return _.catchServerError('admin.dashboardStats', error, res);
    }
};

// ─── User Management ───────────────────────────────────────────────────────
controllers.userList = async (req, res) => {
    try {
        const { sSearch = '', nPage = 1, nLimit = 10 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(50, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const query = {};
        if (sSearch) {
            const re = new RegExp(sSearch, 'i');
            query.$or = [
                { sUsername: re },
                { sEmail: re },
            ];
        }

        const [aUsers, nTotal] = await Promise.all([
            User.find(query)
                .select('sUsername sEmail sBio sProfilePicUrl isActive isDeleted bIsKrakenConnected bIsProfileComplete dCreatedAt')
                .sort({ dCreatedAt: -1 })
                .skip(skip)
                .limit(limit),
            User.countDocuments(query),
        ]);

        return res.reply(messages.success('User list'), {
            aUsers,
            nTotal,
            nPage: page,
            nLimit: limit,
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.userList', error, res);
    }
};

controllers.userDetail = async (req, res) => {
    try {
        const oUser =
            await User.findOne({ _id: req.params.id })
                .select('-sHash -sToken -aSessions -sResetPasswordToken -sResetPasswordExpires');
        if (!oUser) return res.reply(messages.not_found('User'));
        return res.reply(messages.success('User detail'), oUser);
    } catch (error) {
        return _.catchServerError('admin.userDetail', error, res);
    }
};

controllers.userToggleStatus = async (req, res) => {
    try {
        const oUser =
            await User.findOne({ _id: req.params.id, isDeleted: false });
        if (!oUser) return res.reply(messages.not_found('User'));
        oUser.isActive = !oUser.isActive;
        await oUser.save();
        return res.reply(messages.updated(`User ${oUser.isActive ? 'activated' : 'deactivated'}`), { isActive: oUser.isActive });
    } catch (error) {
        return _.catchServerError('admin.userToggleStatus', error, res);
    }
};

controllers.userDelete = async (req, res) => {
    try {
        const oUser = await User.findById(req.params.id);
        if (!oUser) return res.reply(messages.not_found('User'));

        oUser.isDeleted = !oUser.isDeleted;
        if (oUser.isDeleted) {
            if (typeof oUser.clearAllSessions === 'function') {
                await oUser.clearAllSessions();
            } else {
                oUser.sToken = '';
                oUser.aSessions = [];
                await oUser.save();
            }
        } else {
            await oUser.save();
        }

        return res.reply(
            messages.success(`User ${oUser.isDeleted ? 'deleted' : 'restored'}`),
            { isDeleted: oUser.isDeleted }
        );
    } catch (error) {
        return _.catchServerError('admin.userDelete', error, res);
    }
};

// ─── Contact Inquiries ─────────────────────────────────────────────────────
controllers.inquiryList = async (req, res) => {
    try {
        const { sSearch = '', eStatus = '', nPage = 1, nLimit = 10 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(50, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const query = {};
        if (eStatus) query.eStatus = eStatus;
        if (sSearch) {
            const re = new RegExp(sSearch, 'i');
            query.$or = [{ sName: re }, { sEmail: re }, { sMessage: re }];
        }

        const [aInquiries, nTotal] = await Promise.all([
            ContactInquiry
                .find(query).sort({ dCreatedAt: -1 }).skip(skip).limit(limit),
            ContactInquiry.countDocuments(query),
        ]);

        return res.reply(messages.success('Inquiry list'), {
            aInquiries,
            nTotal,
            nPage: page,
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.inquiryList', error, res);
    }
};

controllers.updateInquiryStatus = async (req, res) => {
    try {
        const { eStatus } = req.body;
        if (!['Pending', 'Closed'].includes(eStatus))
            return res.reply(messages.invalid('Status'));

        const inquiry = await ContactInquiry.findByIdAndUpdate(
            req.params.id,
            { eStatus },
            { new: true }
        );
        if (!inquiry) return res.reply(messages.not_found('Inquiry'));
        return res.reply(messages.updated('Inquiry status'), inquiry);
    } catch (error) {
        return _.catchServerError('admin.updateInquiryStatus', error, res);
    }
};

// ─── FAQs ──────────────────────────────────────────────────────────────────
controllers.faqList = async (req, res) => {
    try {
        const { sSearch = '', nPage = 1, nLimit = 10 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(50, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const query = {};
        if (sSearch) {
            const re = new RegExp(sSearch, 'i');
            query.$or = [{ sQuestion: re }, { sAnswer: re }];
        }

        const [aFaqs, nTotal] = await Promise.all([
            Faq.find(query).sort({ dCreatedAt: -1 }).skip(skip).limit(limit),
            Faq.countDocuments(query),
        ]);

        return res.reply(messages.success('FAQ list'), {
            aFaqs,
            nTotal,
            nPage: page,
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.faqList', error, res);
    }
};

controllers.createFaq = async (req, res) => {
    try {
        const { sQuestion, sAnswer } = req.body;
        if (!sQuestion) return res.reply(messages.not_found('Question'));
        if (!sAnswer) return res.reply(messages.not_found('Answer'));

        const faq = await Faq.create({ sQuestion, sAnswer });
        return res.reply(messages.successfully('FAQ created'), faq);
    } catch (error) {
        return _.catchServerError('admin.createFaq', error, res);
    }
};

controllers.updateFaq = async (req, res) => {
    try {
        const { sQuestion, sAnswer } = req.body;
        const faq = await Faq.findByIdAndUpdate(
            req.params.id,
            { sQuestion, sAnswer },
            { new: true }
        );
        if (!faq) return res.reply(messages.not_found('FAQ'));
        return res.reply(messages.updated('FAQ'), faq);
    } catch (error) {
        return _.catchServerError('admin.updateFaq', error, res);
    }
};

controllers.deleteFaq = async (req, res) => {
    try {
        const faq = await Faq.findByIdAndDelete(req.params.id);
        if (!faq) return res.reply(messages.not_found('FAQ'));
        return res.reply(messages.deleted('FAQ'));
    } catch (error) {
        return _.catchServerError('admin.deleteFaq', error, res);
    }
};

// ─── CMS Management ────────────────────────────────────────────────────────
controllers.viewCms = async (req, res) => {
    try {
        const cmsList = await Cms.find();
        return res.reply(messages.success('CMS list'), {
            data: cmsList,
            recordsTotal: cmsList.length,
            recordsFiltered: cmsList.length,
        });
    } catch (error) {
        return _.catchServerError('admin.viewCms', error, res);
    }
};

controllers.getCms = async (req, res) => {
    try {
        const cmsContent = await Cms.findById(req.params.id);
        if (!cmsContent) return res.reply(messages.not_found('CMS'));
        return res.reply(messages.success('CMS fetched'), cmsContent);
    } catch (error) {
        return _.catchServerError('admin.getCms', error, res);
    }
};

controllers.updateCmsContent = async (req, res) => {
    try {
        const { title, description } = req.body;
        if (!title) return res.reply(messages.not_found('Title'));

        const cmsContent = await Cms.findOneAndUpdate(
            { sTitle: title },
            { sDescription: description },
            { new: true, upsert: true }
        );

        if (!cmsContent) return res.reply(messages.not_found(`${title} not found`));
        return res.reply(
            messages.successfully(`${title} updated successfully`),
            cmsContent
        );
    } catch (error) {
        return _.catchServerError('admin.updateCmsContent', error, res);
    }
};

// ─── Reply to Inquiry ─────────────────────────────────────────────────────────

controllers.replyToInquiry = async (req, res) => {
    try {
        const { sReply } = req.body;
        if (!sReply || !sReply.trim())
            return res.reply(messages.not_found('Reply message'));

        const inquiry = await ContactInquiry.findById(req.params.id);
        if (!inquiry) return res.reply(messages.not_found('Inquiry'));

        inquiry.sAdminReply = sReply.trim();
        inquiry.eStatus = 'Closed';
        await inquiry.save();

        // Send reply email to the user
        await nodemailer.send(
            'inquiry_reply.html',
            {
                SITE_NAME: config.SITE_NAME,
                USER_NAME: inquiry.sName,
                ORIGINAL_MESSAGE: inquiry.sMessage,
                ADMIN_REPLY: sReply.trim(),
            },
            {
                from: config.SMTP_FROM,
                to: inquiry.sEmail,
                subject: `Re: Your message to ${config.SITE_NAME}`,
            }
        );

        return res.reply(messages.successfully('Reply sent'), inquiry);
    } catch (error) {
        return _.catchServerError('admin.replyToInquiry', error, res);
    }
};

// ─── Features ──────────────────────────────────────────────────────────────────

controllers.featureList = async (req, res) => {
    try {
        const { nPage = 1, nLimit = 20 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(100, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const [aFeatures, nTotal] = await Promise.all([
            Feature.find().sort({ nOrder: 1, dCreatedAt: 1 })
                .skip(skip).limit(limit),
            Feature.countDocuments(),
        ]);
        return res.reply(messages.success('Feature list'), {
            aFeatures, nTotal, nPage: page, 
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.featureList', error, res);
    }
};

controllers.createFeature = async (req, res) => {
    try {
        const { sTitle, sDescription, sIconType, nOrder, eStatus } = req.body;
        if (!sTitle) return res.reply(messages.not_found('Title'));
        if (!sDescription) return res.reply(messages.not_found('Description'));
        if (!sIconType) return res.reply(messages.not_found('Icon type'));

        const feature = await Feature.create({ sTitle, sDescription, sIconType, nOrder: nOrder ?? 0, eStatus: eStatus ?? 'Active' });
        return res.reply(messages.successfully('Feature created'), feature);
    } catch (error) {
        return _.catchServerError('admin.createFeature', error, res);
    }
};

controllers.updateFeature = async (req, res) => {
    try {
        const { sTitle, sDescription, sIconType, nOrder, eStatus } = req.body;
        const feature = await Feature.findByIdAndUpdate(
            req.params.id,
            { sTitle, sDescription, sIconType, nOrder, eStatus },
            { new: true, runValidators: true }
        );
        if (!feature) return res.reply(messages.not_found('Feature'));
        return res.reply(messages.updated('Feature'), feature);
    } catch (error) {
        return _.catchServerError('admin.updateFeature', error, res);
    }
};

controllers.deleteFeature = async (req, res) => {
    try {
        const feature = await Feature.findByIdAndDelete(req.params.id);
        if (!feature) return res.reply(messages.not_found('Feature'));
        return res.reply(messages.deleted('Feature'));
    } catch (error) {
        return _.catchServerError('admin.deleteFeature', error, res);
    }
};

// ─── News Articles ─────────────────────────────────────────────────────────────

controllers.newsList = async (req, res) => {
    try {
        const { nPage = 1, nLimit = 20 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(100, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const [aArticles, nTotal] = await Promise.all([
            NewsArticle.find()
                .sort({ bIsFeatured: -1, dCreatedAt: -1 })
                .skip(skip).limit(limit),
            NewsArticle.countDocuments(),
        ]);
        return res.reply(messages.success('News list'), {
            aArticles, nTotal, nPage: page, 
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.newsList', error, res);
    }
};

controllers.createNews = async (req, res) => {
    try {
        const { 
            sTitle, 
            sExcerpt, 
            sTag, sDate, nReadMinutes, bIsFeatured, eStatus } = req.body;
        if (!sTitle) return res.reply(messages.not_found('Title'));
        if (!sExcerpt) return res.reply(messages.not_found('Excerpt'));
        if (!sTag) return res.reply(messages.not_found('Tag'));
        if (!sDate) return res.reply(messages.not_found('Date'));

        const article = await NewsArticle.create({
            sTitle, sExcerpt, sTag, sDate,
            nReadMinutes: nReadMinutes ?? 3,
            bIsFeatured: bIsFeatured ?? false,
            eStatus: eStatus ?? 'Active',
        });
        return res.reply(messages.successfully('Article created'), article);
    } catch (error) {
        return _.catchServerError('admin.createNews', error, res);
    }
};

controllers.updateNews = async (req, res) => {
    try {
        const { 
            sTitle, 
            sExcerpt, 
            sTag, sDate, nReadMinutes, bIsFeatured, eStatus } = req.body;
        const article = await NewsArticle.findByIdAndUpdate(
            req.params.id,
            { sTitle, 
                sExcerpt, sTag, sDate, nReadMinutes, bIsFeatured, eStatus },
            { new: true, runValidators: true }
        );
        if (!article) return res.reply(messages.not_found('Article'));
        return res.reply(messages.updated('Article'), article);
    } catch (error) {
        return _.catchServerError('admin.updateNews', error, res);
    }
};

controllers.deleteNews = async (req, res) => {
    try {
        const article = await NewsArticle.findByIdAndDelete(req.params.id);
        if (!article) return res.reply(messages.not_found('Article'));
        return res.reply(messages.deleted('Article'));
    } catch (error) {
        return _.catchServerError('admin.deleteNews', error, res);
    }
};

// ─── CoinDCX Futures Candle Scanner ──────────────────────────────────────────
controllers.coindcxScannerStatus = async (req, res) => {
    try {
        return res.reply(messages.success('CoinDCX scanner status'),
            coindcxCandleScanner.status());
    } catch (error) {
        return _.catchServerError('admin.coindcxScannerStatus', error, res);
    }
};

controllers.startCoindcxScanner = async (req, res) => {
    try {
        const status = await coindcxCandleScanner.start();
        return res.reply(messages.successfully('CoinDCX scanner started'), status);
    } catch (error) {
        return _.catchServerError('admin.startCoindcxScanner', error, res);
    }
};

controllers.stopCoindcxScanner = async (req, res) => {
    try {
        const status = await coindcxCandleScanner.stop();
        return res.reply(messages.successfully('CoinDCX scanner stopped'), status);
    } catch (error) {
        return _.catchServerError('admin.stopCoindcxScanner', error, res);
    }
};

controllers.scanCoindcxNow = async (req, res) => {
    try {
        await coindcxCandleScanner.runCronPoll();
        return res.reply(
            messages.successfully('CoinDCX futures scan completed'),
            coindcxCandleScanner.status(),
        );
    } catch (error) {
        return _.catchServerError('admin.scanCoindcxNow', error, res);
    }
};

controllers.testCoindcxScannerEmail = async (req, res) => {
    try {
        await coindcxCandleScanner.sendTestEmail();
        return res.reply(messages.successfully('CoinDCX scanner test email sent'));
    } catch (error) {
        return _.catchServerError('admin.testCoindcxScannerEmail', error, res);
    }
};

controllers.coindcxAlertList = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.nPage || 1));
        const limit = Math.min(
            50,
            Math.max(1, parseInt(req.query.nLimit || 20)),
        );
        const skip = (page - 1) * limit;
        const [aAlerts, nTotal] = await Promise.all([
            CandleAlert.find().sort({ dCreatedAt: -1 }).skip(skip).limit(limit),
            CandleAlert.countDocuments(),
        ]);
        return res.reply(messages.success('CoinDCX alert list'), {
            aAlerts,
            aLatestSignals: aAlerts.map(toLatestSignalView),
            nTotal,
            nPage: page,
            nLimit: limit,
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('admin.coindcxAlertList', error, res);
    }
};

controllers.coindcxLatestSignals = async (req, res) => {
    try {
        const limit = Math.min(
            50,
            Math.max(1, parseInt(req.query.nLimit || 20)),
        );
        const minConfidence = req.query.nMinConfidence == null
            ? null
            : Number(req.query.nMinConfidence);
        const filter = {};
        if (Number.isFinite(minConfidence)) {
            filter.nConfidence = { $gte: minConfidence };
        }
        if (req.query.sDirection) {
            filter.sDirection = String(req.query.sDirection).toLowerCase();
        }
        if (req.query.sPair) {
            filter.sPair = String(req.query.sPair).trim();
        }

        const aAlerts = await CandleAlert.find(filter)
            .sort({ dCreatedAt: -1 })
            .limit(limit);
        return res.reply(messages.success('CoinDCX latest signals'), {
            aSignals: aAlerts.map(toLatestSignalView),
            nCount: aAlerts.length,
            nLimit: limit,
            oDetection: coindcxCandleScanner.status().oDetection,
        });
    } catch (error) {
        return _.catchServerError('admin.coindcxLatestSignals', error, res);
    }
};

/**
 * Verify CoinDCX API key/secret can call authenticated endpoints.
 * Does not place orders. Uses POST /exchange/v1/users/info
 */
controllers.coindcxVerifyCredentials = async (req, res) => {
    try {
        const trading = require('../../services/coindcx/coindcxFuturesTradingClient');
        const result = await trading.verifyCredentials();
        if (!result.ok) {
            return res.reply(messages.unauthorized(
                `CoinDCX auth failed (${result.status}): ${result.message}`,
            ), result);
        }
        return res.reply(messages.success('CoinDCX credentials valid'), {
            status: result.status,
            hasData: Boolean(result.data),
        });
    } catch (error) {
        return _.catchServerError('admin.coindcxVerifyCredentials', error, res);
    }
};

module.exports = controllers;
