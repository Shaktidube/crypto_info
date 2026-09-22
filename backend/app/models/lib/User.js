const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../../../config/config');

const User = mongoose.Schema(
    {
        sEmail: {
            type: String,
            unique: true,
            required: true,
            lowercase: true,
            trim: true,
        },
        sUsername: {
            type: String,
            sparse: true,
            trim: true,
        },
        sBio: {
            type: String,
            default: '',
        },
        sProfilePicUrl: {
            type: String,
            default: '',
        },
        /**
         * Legacy single-session field. New logins append to aSessions instead so
         * phone + desktop can stay signed in together. Kept for migration / older tokens.
         */
        sToken: {
            type: String,
            default: '',
        },
        /** Active JWTs across devices (each login keeps an independent session). */
        aSessions: {
            type: [
                {
                    sToken: { type: String, required: true },
                    dCreatedAt: { type: Date, default: Date.now },
                    dExpiresAt: { type: Date, default: null },
                    dLastUsedAt: { type: Date, default: Date.now },
                    sDeviceHash: { type: String, default: null },
                },
            ],
            default: [],
        },
        sOtp: {
            type: String,
            default: null,
        },
        dOtpExpires: {
            type: Date,
            default: null,
        },
        /** Browser/device trust records (hashed device id — see trustedDevice.js). */
        aTrustedDevices: {
            type: [
                {
                    sDeviceHash: { type: String, required: true },
                    dTrustedAt: { type: Date, required: true },
                    dLastActiveAt: { type: Date, required: true },
                    dExpiresAt: { type: Date, required: true },
                },
            ],
            default: [],
        },
        sGoogleId: {
            type: String,
            default: null,
            sparse: true,
        },
        bIsProfileComplete: {
            type: Boolean,
            default: false,
        },
        bIsKrakenConnected: {
            type: Boolean,
            default: false,
        },
        sKrakenCode: {
            type: String,
            default: null,
        },
        sKrakenAccessToken: {
            type: String,
            default: null,
        },
        sKrakenRefreshToken: {
            type: String,
            default: null,
        },
        sKrakenApiKey: {
            type: String,
            default: null,
        },
        sKrakenApiSecret: {
            type: String,
            default: null,
        },
        oPassportStats: {
            sRoi: { type: String, default: null },
            nWinRate: { type: Number, default: null },
            nTotalTrades: { type: Number, default: null },
            sBestAsset: { type: String, default: null },
            dLastUpdated: { type: Date, default: null },
        },
        /** Precomputed stats per period (1w, 1m, 3m, 6m, all) — served instantly, synced in background. */
        oKrakenStatsByPeriod: {
            type: mongoose.Schema.Types.Mixed,
            default: null,
        },
        dKrakenStatsSyncedAt: {
            type: Date,
            default: null,
        },
        bIsFoundingMember: {
            type: Boolean,
            default: false,
        },
        nKrakenConnectRank: {
            type: Number,
            default: null,
        },
        isDeleted: {
            type: Boolean,
            default: false,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

User.index({ sEmail: 1 });

User.statics.findByToken = async function (token) {
    let decoded;
    try {
        decoded = jwt.verify(token, config.JWT_SECRET);
    } catch (e) {
        return Promise.reject(e);
    }

    const user = await this.findOne({
        _id: decoded._id,
        $or: [
            { 'aSessions.sToken': token },
            { sToken: token },
        ],
    });

    if (!user) return null;

    const now = Date.now();
    const session = (user.aSessions || []).find((s) => s.sToken === token);
    if (session) {
        if (session.dExpiresAt && new Date(session.dExpiresAt).getTime() < now) {
            user.aSessions = user.aSessions.filter((s) => s.sToken !== token);
            await user.save();
            return null;
        }
        session.dLastUsedAt = new Date();
        // Touch without blocking the request on save failures.
        user.save().catch(() => {});
        return user;
    }

    // Legacy single-token row: accept and migrate into aSessions on next login.
    if (user.sToken === token) return user;

    return null;
};

/**
 * Adds an independent session JWT. Does not invalidate other devices' sessions.
 * @param {string} token
 * @param {{ expiresAt?: Date|null, sDeviceHash?: string|null }} [meta]
 */
User.methods.addSession = async function addSession(token, meta = {}) {
    const max = config.MAX_USER_SESSIONS || 20;
    if (!Array.isArray(this.aSessions)) this.aSessions = [];

    const now = new Date();
    // Drop expired / exact duplicate for this token, then append.
    this.aSessions = this.aSessions.filter((s) => {
        if (!s?.sToken || s.sToken === token) return false;
        if (s.dExpiresAt && new Date(s.dExpiresAt).getTime() < now.getTime()) {
            return false;
        }
        return true;
    });

    this.aSessions.push({
        sToken: token,
        dCreatedAt: now,
        dLastUsedAt: now,
        dExpiresAt: meta.expiresAt || null,
        sDeviceHash: meta.sDeviceHash || null,
    });

    while (this.aSessions.length > max) {
        this.aSessions.shift();
    }

    // Clear legacy field so old single-token overwrite behaviour is gone.
    this.sToken = '';
    await this.save();
    return this;
};

/**
 * Removes one session JWT (logout on this device only).
 * @param {string} token
 */
User.methods.removeSession = async function removeSession(token) {
    if (!token) return this;
    if (Array.isArray(this.aSessions) && this.aSessions.length) {
        this.aSessions = this.aSessions.filter((s) => s.sToken !== token);
    }
    if (this.sToken === token) this.sToken = '';
    await this.save();
    return this;
};

/** Invalidates every session (e.g. admin soft-delete). */
User.methods.clearAllSessions = async function clearAllSessions() {
    this.aSessions = [];
    this.sToken = '';
    await this.save();
    return this;
};

module.exports = mongoose.model('users', User);
