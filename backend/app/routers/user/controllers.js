const axios = require('axios');
const fs = require('fs');
const NodeCache = require('node-cache');
const {
    User,
    ContactInquiry,
    Faq,
    Feature,
    NewsArticle,
    Cms,
    CandleAlert,
} = require('../../models/index');
const { nodemailer, aws } = require('../../utils');
const config = require('../../../config/config');
const { toLatestSignalView } = require(
    '../../services/coindcx/alertPayload'
);
const { subscriptionView } = require('../../services/billing/plans');
const {
    computeKrakenStatsFromRaw,
    fetchKrakenStatsRawData,
    refreshKrakenToken,
    getFastApiKey,
    deleteAllTinkaFastApiKeys,
    krakenPrivateBearer,
    createCcxtApiFn,
} = require('../../utils/lib/krakenStats');

// In-memory hot cache (5 min). Authoritative copy lives in MongoDB (oKrakenStatsByPeriod).
const statsCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const krakenRawCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
const {
    VALID_PERIODS,
    normalizePeriodKey,
    migrateLegacyPeriodKeys,
    isValidPeriod,
} = require('../../utils/lib/krakenPeriods');
const STATS_STALE_MS = 2 * 60 * 1000;

// Per-user Kraken call serialization (background sync only — never blocks HTTP).
const userKrakenLocks = new Map();
const krakenRefreshScheduled = new Set();

const controllers = {};

const PUBLIC_PROFILE_SELECT = [
    'sUsername',
    'sBio',
    'sProfilePicUrl',
    'dUpdatedAt',
    'bIsKrakenConnected',
    'bIsFoundingMember',
    'nKrakenConnectRank',
    'sKrakenAccessToken',
    'sKrakenRefreshToken',
    'sKrakenApiKey',
    'sKrakenApiSecret',
].join(' ');

const STATS_USER_SELECT = `${PUBLIC_PROFILE_SELECT} oKrakenStatsByPeriod dKrakenStatsSyncedAt`;

// Repair: if bIsKrakenConnected was wrongly set to false but tokens still exist,
// treat the user as connected so stats can be fetched.
function repairKrakenConnectedFlag(oUser) {
    if (
        !oUser.bIsKrakenConnected &&
        (oUser.sKrakenAccessToken || oUser.sKrakenRefreshToken)
    ) {
        oUser.bIsKrakenConnected = true;
    }
}

/**
 * Ensures we can call Kraken private REST (Balance, etc.): verifies stored API key,
 * or refreshes OAuth and mints a new fast key, or falls back to Bearer-only.
 * Survives returning users after days away (expired access token / stale keys).
 *
 * @returns {Promise<{ apiKey: string|null, apiSecret: string|null, bearerToken: string|null }|null>}
 */
async function ensureKrakenAuthForUser(oUser) {
    if (!oUser.bIsKrakenConnected) return null;

    async function persistTokens(tokens) {
        await User.findByIdAndUpdate(oUser._id, {
            sKrakenAccessToken: tokens.access_token,
            sKrakenRefreshToken:
                tokens.refresh_token || oUser.sKrakenRefreshToken,
        });
        oUser.sKrakenAccessToken = tokens.access_token;
        if (tokens.refresh_token) {
            oUser.sKrakenRefreshToken = tokens.refresh_token;
        }
    }

    async function refreshOAuthIfPossible() {
        if (!oUser.sKrakenRefreshToken) return false;
        try {
            const tokens = await refreshKrakenToken(oUser.sKrakenRefreshToken);
            await persistTokens(tokens);
            return true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[ensureKrakenAuth] refresh failed:', err.message);
            return false;
        }
    }

    async function balanceOkWithApiKey() {
        if (!oUser.sKrakenApiKey || !oUser.sKrakenApiSecret) return false;
        try {
            // Must use CCXT here (same nonce scale as computeKrakenStats).
            // krakenPrivateApiKey uses nanosecond nonces; CCXT uses millisecond nonces.
            // Mixing them causes EAPI:Invalid nonce on the subsequent CCXT stats call.
            const fn = createCcxtApiFn(
                oUser.sKrakenApiKey,
                oUser.sKrakenApiSecret,
            );
            await fn('Balance', {});
            return true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[ensureKrakenAuth] Balance (API key) failed:', err.message);
            // Nonce errors mean the key's nonce watermark is permanently ahead.
            // Clear the in-memory key so mintFastKeyAndPersist will replace it.
            if (err.message && err.message.includes('nonce')) {
                oUser.sKrakenApiKey = null;
                oUser.sKrakenApiSecret = null;
            }
            return false;
        }
    }

    async function balanceOkWithBearer() {
        if (!oUser.sKrakenAccessToken) return false;
        try {
            await krakenPrivateBearer(
                'Balance',
                oUser.sKrakenAccessToken,
                {},
            );
            return true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[ensureKrakenAuth] Balance (Bearer) failed:', err.message);
            return false;
        }
    }

    async function mintFastKeyAndPersist() {
        if (!oUser.sKrakenAccessToken) return false;
        try {
            // DELETE /oauth/fast-api-key for any existing tinka- prefixed keys.
            // Helps avoid "EAccount:Too many API keys" on reconnect.
            await deleteAllTinkaFastApiKeys(oUser.sKrakenAccessToken);
            const fastKey = await getFastApiKey(oUser.sKrakenAccessToken);
            await User.findByIdAndUpdate(oUser._id, {
                sKrakenApiKey: fastKey.apiKey,
                sKrakenApiSecret: fastKey.apiSecret,
            });
            oUser.sKrakenApiKey = fastKey.apiKey;
            oUser.sKrakenApiSecret = fastKey.apiSecret;
            return true;
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[ensureKrakenAuth] fast-api-key mint failed:', err.message);
            return false;
        }
    }

    if (await balanceOkWithApiKey()) {
        return {
            apiKey: oUser.sKrakenApiKey,
            apiSecret: oUser.sKrakenApiSecret,
            bearerToken: oUser.sKrakenAccessToken,
        };
    }

    if (oUser.sKrakenRefreshToken) {
        await refreshOAuthIfPossible();
    }

    if (await mintFastKeyAndPersist()) {
        return {
            apiKey: oUser.sKrakenApiKey,
            apiSecret: oUser.sKrakenApiSecret,
            bearerToken: oUser.sKrakenAccessToken,
        };
    }

    if (await balanceOkWithBearer()) {
        return {
            apiKey: null,
            apiSecret: null,
            bearerToken: oUser.sKrakenAccessToken,
        };
    }

    if (oUser.sKrakenRefreshToken && (await refreshOAuthIfPossible())) {
        if (await mintFastKeyAndPersist()) {
            return {
                apiKey: oUser.sKrakenApiKey,
                apiSecret: oUser.sKrakenApiSecret,
                bearerToken: oUser.sKrakenAccessToken,
            };
        }
        if (await balanceOkWithBearer()) {
            return {
                apiKey: null,
                apiSecret: null,
                bearerToken: oUser.sKrakenAccessToken,
            };
        }
    }

    return null;
}

function statsCacheKey(userId, period) {
    return `stats:${userId}:${period}`;
}

function krakenRawCacheKey(userId) {
    return `raw:${userId}`;
}

function isStatsStale(syncedAt) {
    if (!syncedAt) return true;
    return Date.now() - new Date(syncedAt).getTime() > STATS_STALE_MS;
}

function hasPeriodData(periods) {
    if (!periods || typeof periods !== 'object') return false;
    return VALID_PERIODS.some((p) => periods[p] != null);
}

function hydrateMemoryCacheFromDb(userId, periods) {
    if (!periods) return;
    for (const p of VALID_PERIODS) {
        if (periods[p]) {
            statsCache.set(statsCacheKey(userId, p), periods[p]);
        }
    }
}

/**
 * Loads stats from in-memory cache or MongoDB — never calls Kraken.
 * @returns {Object|null} Map of period → stats
 */
function loadPersistedPeriods(oUser) {
    const userId = String(oUser._id);

    const fromMemory = {};
    let hasMemory = false;
    for (const p of VALID_PERIODS) {
        const v = statsCache.get(statsCacheKey(userId, p));
        if (v !== undefined) {
            fromMemory[p] = v;
            hasMemory = true;
        }
    }
    if (hasMemory) return migrateLegacyPeriodKeys(fromMemory);

    const db = migrateLegacyPeriodKeys(oUser.oKrakenStatsByPeriod);
    if (db && typeof db === 'object') {
        hydrateMemoryCacheFromDb(userId, db);
        return db;
    }
    return null;
}

function invalidateUserStatsCaches(userId) {
    for (const p of VALID_PERIODS) {
        statsCache.del(statsCacheKey(userId, p));
    }
    krakenRawCache.del(krakenRawCacheKey(userId));
}

/**
 * Atomic per-user mutex for background Kraken sync only.
 * @template T
 * @param {string|import('mongoose').Types.ObjectId} userId
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withUserKrakenLock(userId, fn) {
    const id = String(userId);
    while (userKrakenLocks.has(id)) {
        await userKrakenLocks.get(id).catch(() => {});
    }
    const run = (async () => fn())();
    userKrakenLocks.set(id, run);
    try {
        return await run;
    } finally {
        if (userKrakenLocks.get(id) === run) {
            userKrakenLocks.delete(id);
        }
    }
}

function createApiFnForAuth(auth) {
    if (auth.apiKey && auth.apiSecret) {
        return createCcxtApiFn(auth.apiKey, auth.apiSecret);
    }
    if (auth.bearerToken) {
        return (ep, params) => 
            krakenPrivateBearer(ep, auth.bearerToken, params);
    }
    return null;
}

async function persistPassportSummary(userId, allStats) {
    if (!allStats) return;
    const isEmptyStats =
        (allStats.roi === 0 || allStats.roi === '0' || allStats.roi === null) &&
        (allStats.winRate === 0 || allStats.winRate === null) &&
        (allStats.totalTrades === 0 || allStats.totalTrades === null) &&
        (allStats.bestAsset === null || allStats.bestAsset === undefined);
    if (isEmptyStats) return;

    await User.findByIdAndUpdate(userId, {
        $set: {
            oPassportStats: {
                sRoi: allStats.roi ?? null,
                nWinRate: allStats.winRate ?? null,
                nTotalTrades: allStats.totalTrades ?? null,
                sBestAsset: allStats.bestAsset ?? null,
                dLastUpdated: new Date(),
            },
        },
    });
}

/**
 * Fire-and-forget: ask the frontend to pre-render passport OG/Twitter PNGs
 * for dark+light across all periods so social crawlers hit a warm cache.
 */
function schedulePassportOgWarm(profile, periodsByKey) {
    const username = String(profile?.sUsername || '').trim();
    const origin = String(
        config.FRONTEND_URL || config.WEB_URL || '',
    ).replace(/\/$/, '');
    if (!username || !origin || !periodsByKey) return;

    setImmediate(async () => {
        const warmUrl = `${origin}/api/og/passport/warm`;
        const periodKeys = VALID_PERIODS.filter((p) => periodsByKey[p]);
        // Warm "all" first (default share), then remaining periods.
        const ordered = [
            ...periodKeys.filter((p) => p === 'all'),
            ...periodKeys.filter((p) => p !== 'all'),
        ];

        for (const period of ordered) {
            const s = periodsByKey[period];
            if (!s) continue;
            try {
                await axios.post(
                    warmUrl,
                    {
                        username,
                        period,
                        periods: [period],
                        themes: ['dark', 'light'],
                        roi: s.roi ?? null,
                        winRate: s.winRate != null ? `${s.winRate}%` : null,
                        bestAsset: s.bestAsset ?? null,
                        trades: s.totalTrades != null ? String(s.totalTrades) : null,
                        isFoundingMember: !!profile.bIsFoundingMember,
                        foundingMemberRank: profile.nKrakenConnectRank ?? null,
                        bIsKrakenConnected: profile.bIsKrakenConnected !== false,
                    },
                    { timeout: 55000 },
                );
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(
                    `[passport-og-warm] ${username} ${period}:`,
                    err?.message || err,
                );
            }
        }
    });
}

/**
 * Fetches from Kraken and persists to MongoDB. Runs in background — never awaited by HTTP handlers.
 */
function syncKrakenStatsInBackground(oUser) {
    const userId = String(oUser._id);
    if (krakenRefreshScheduled.has(userId)) return;
    krakenRefreshScheduled.add(userId);

    // eslint-disable-next-line no-console
    console.log(`[syncKrakenStats] START user=${userId} @ ${new Date().toISOString()}`);

    setImmediate(async () => {
        try {
            await withUserKrakenLock(userId, async () => {
                const freshUser = await User.findById(userId)
                    .select(PUBLIC_PROFILE_SELECT)
                    .lean();
                if (!freshUser?.bIsKrakenConnected) return;

                repairKrakenConnectedFlag(freshUser);
                // eslint-disable-next-line no-console
                console.log(`[syncKrakenStats] AUTH user=${userId}`);
                const auth = await ensureKrakenAuthForUser(freshUser);
                if (!auth) {
                    // eslint-disable-next-line no-console
                    console.warn(`[syncKrakenStats] AUTH failed user=${userId}`);
                    return;
                }

                const apiFn = createApiFnForAuth(auth);
                if (!apiFn) return;

                // eslint-disable-next-line no-console
                console.log(`[syncKrakenStats] KRAKEN FETCH user=${userId}`);
                const rawData = await fetchKrakenStatsRawData(
                    apiFn,
                    auth.bearerToken,
                    userId,
                );
                // eslint-disable-next-line no-console
                console.log(`[syncKrakenStats] COMPUTE user=${userId}`);
                const periods = {};
                for (const p of VALID_PERIODS) {
                    periods[p] = computeKrakenStatsFromRaw(rawData, p);
                    statsCache.set(statsCacheKey(userId, p), periods[p]);
                }
                krakenRawCache.set(krakenRawCacheKey(userId), rawData);

                const now = new Date();
                await User.findByIdAndUpdate(userId, {
                    $set: {
                        oKrakenStatsByPeriod: periods,
                        dKrakenStatsSyncedAt: now,
                    },
                });
                await persistPassportSummary(userId, periods.all);
                schedulePassportOgWarm(freshUser, periods);
                // eslint-disable-next-line no-console
                console.log(
                    `[syncKrakenStats] SAVED user=${userId} periods=${Object.keys(periods).join(',')} @ ${now.toISOString()}`,
                );
            });
        } catch (err) {
            // eslint-disable-next-line no-console
            console.warn('[syncKrakenStats] FAIL', userId, err.message);
        } finally {
            krakenRefreshScheduled.delete(userId);
        }
    });
}

/**
 * Schedules Kraken sync when data is stale (>2 min) or missing.
 * Returns refreshing=true while Kraken fetch runs so frontend fast-polls (30s)
 * and picks up fresh trades as soon as they are saved to MongoDB.
 */
function isRefreshingStats(userId, oUser, periods, syncedAt) {
    const id = String(userId);
    const syncInProgress = 
    krakenRefreshScheduled.has(id) || userKrakenLocks.has(id);

    if (syncInProgress) {
        // eslint-disable-next-line no-console
        console.log(`[getStats] user=${id} refreshing=true (Kraken API sync in progress)`);
        return true;
    }

    const needsSync = isStatsStale(syncedAt) || !hasPeriodData(periods);
    if (needsSync) {
        // eslint-disable-next-line no-console
        console.log(
            `[getStats] user=${id} → starting Kraken sync ` +
            `(stale=${isStatsStale(syncedAt)} hasData=${hasPeriodData(periods)}) — ` +
            'will fetch fresh trades from Kraken API',
        );
        syncKrakenStatsInBackground(oUser);
        return true;
    }

    return false;
}

async function buildPassportPayload(oUser, period = 'all') {
    const profile = buildPassportProfile(oUser);
    const periodKey = normalizePeriodKey(period);

    if (!oUser.bIsKrakenConnected) {
        return { profile, stats: null };
    }

    const periods = loadPersistedPeriods(oUser);
    isRefreshingStats(oUser._id, oUser, periods, oUser.dKrakenStatsSyncedAt);

    const stats = periods?.[periodKey] ?? null;
    return { profile, stats };
}

function buildPassportProfile(oUser) {
    return {
        sUsername: oUser.sUsername || '',
        sBio: oUser.sBio || '',
        sProfilePicUrl: aws.formatProfilePicUrlForClient(
            oUser.sProfilePicUrl || '',
            oUser.dUpdatedAt
        ),
        bIsKrakenConnected: !!oUser.bIsKrakenConnected,
        bIsFoundingMember: !!oUser.bIsFoundingMember,
        nKrakenConnectRank: oUser.nKrakenConnectRank ?? null,
    };
}

function buildPassportAllPeriodsResponse(oUser) {
    const profile = buildPassportProfile(oUser);
    if (!oUser.bIsKrakenConnected) {
        return {
            profile,
            periods: {},
            syncedAt: null,
            refreshing: false,
        };
    }
    const periods = loadPersistedPeriods(oUser);
    const syncedAt = oUser.dKrakenStatsSyncedAt || null;
    const refreshing = isRefreshingStats(oUser._id, oUser, periods, syncedAt);
    return {
        profile,
        periods: periods || {},
        syncedAt,
        refreshing,
    };
}

// ─── Kraken OAuth ─────────────────────────────────────────────────────────────

// POST /auth/kraken/callback  [Protected]
// Body: { code }
controllers.krakenCallback = async (req, res) => {
    try {
        const { code } = req.body;
        if (!code) {
            return res.reply(messages.required_field('code'));
        }

        const credentials = Buffer.from(
            `${config.KRAKEN_CLIENT_ID}:${config.KRAKEN_CLIENT_SECRET}`
        ).toString('base64');

        const body = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: config.KRAKEN_REDIRECT_URI,
        });

        let tokenData;
        try {
            const response = await axios.post(
                config.KRAKEN_TOKEN_ENDPOINT,
                body.toString(),
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Accept': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${credentials}`,
                    },
                }   
            );
            tokenData = response.data;
        } catch (err) {
            return res.reply(messages.invalid('Kraken authorization code'), err);
        }

        let sKrakenApiKey;
        let sKrakenApiSecret;
        try {
            // DELETE /oauth/fast-api-key for any existing tinka- prefixed keys.
            // Helps avoid "EAccount:Too many API keys" on reconnect.
            await deleteAllTinkaFastApiKeys(tokenData.access_token);
            const fastKey = await getFastApiKey(tokenData.access_token);
            sKrakenApiKey = fastKey.apiKey;
            sKrakenApiSecret = fastKey.apiSecret;
        } catch (fastKeyErr) {
            // Non-fatal: user can still use Bearer; do not null out existing keys
            // eslint-disable-next-line no-console
            console.warn('[krakenCallback] fast-api-key failed:', fastKeyErr.message);
        }

        const krakenUpdate = {
            sKrakenCode: code,
            sKrakenAccessToken: tokenData.access_token,
            bIsKrakenConnected: true,
        };
        if (tokenData.refresh_token) {
            krakenUpdate.sKrakenRefreshToken = tokenData.refresh_token;
        }
        if (sKrakenApiKey && sKrakenApiSecret) {
            krakenUpdate.sKrakenApiKey = sKrakenApiKey;
            krakenUpdate.sKrakenApiSecret = sKrakenApiSecret;
        }

        // Assign founding member rank (first 100 users to connect Kraken)
        const existingUser = await User.findById(req.userId).select('bIsFoundingMember nKrakenConnectRank').lean();
        if (!existingUser.nKrakenConnectRank) {
            const connectedCount = 
            await User.countDocuments({ bIsKrakenConnected: true });
            const rank = connectedCount + 1;
            krakenUpdate.nKrakenConnectRank = rank;
            if (rank <= 100) {
                krakenUpdate.bIsFoundingMember = true;
            }
        }

        await User.findByIdAndUpdate(req.userId, krakenUpdate);

        invalidateUserStatsCaches(String(req.userId));
        await User.findByIdAndUpdate(req.userId, {
            $set: {
                oKrakenStatsByPeriod: null,
                dKrakenStatsSyncedAt: null,
            },
        });

        const connectedUser = await User.findById(req.userId)
            .select(PUBLIC_PROFILE_SELECT)
            .lean();
        if (connectedUser) {
            syncKrakenStatsInBackground(connectedUser);
        }

        return res.reply(messages.successfully('Kraken Connected'), {
            bIsKrakenConnected: true,
        });
    } catch (error) {
        return _.catchServerError('user.krakenCallback', error, res);
    }
};  

controllers.getStats = async (req, res) => {
    try {
        const oUser = await User.findById(req.userId)
            .select(STATS_USER_SELECT)
            .lean();
        if (!oUser) return res.reply(messages.not_found('User'));

        repairKrakenConnectedFlag(oUser);
        if (!oUser.bIsKrakenConnected) {
            return res.reply(messages.bad_request('Kraken account not connected'));
        }

        const periods = loadPersistedPeriods(oUser);
        const syncedAt = oUser.dKrakenStatsSyncedAt || null;
        const refreshing = 
        isRefreshingStats(oUser._id, oUser, periods, syncedAt);

        // eslint-disable-next-line no-console
        console.log(
            `[getStats] user=${String(req.userId)} refreshing=${refreshing} ` +
            `syncedAt=${syncedAt ? new Date(syncedAt).toISOString() : 'null'} ` +
            `periods=${periods ? Object.keys(periods).length : 0} ` +
            '(DB read + Kraken sync if data older than 2 min)',
        );

        const wantsAllPeriods = !req.query.period || req.query.allPeriods === 'true';

        if (wantsAllPeriods) {
            return res.reply(messages.successfully('Stats'), {
                periods: periods || {},
                syncedAt,
                refreshing,
            });
        }

        const period = isValidPeriod(req.query.period)
            ? normalizePeriodKey(req.query.period)
            : 'all';
        const stats = periods?.[period] ?? null;

        if (stats) {
            return res.reply(messages.successfully('Stats'), stats);
        }

        return res.reply(messages.successfully('Stats'), {
            periods: {},
            syncedAt: null,
            refreshing: true,
        });
    } catch (error) {
        return _.catchServerError('user.getStats', error, res);
    }
};

// GET /public/profile-pic/:filename
controllers.serveProfilePic = async (req, res) => {
    try {
        const filePath = aws.getProfilePicFilePath(req.params.filename);
        if (!filePath || !fs.existsSync(filePath)) {
            return res.status(404).json({ message: 'Not found' });
        }
        return res.sendFile(filePath);
    } catch (error) {
        return _.catchServerError('user.serveProfilePic', error, res);
    }
};

// GET /user/profile  [Protected]
controllers.getProfile = async (req, res) => {
    try {
        const oUser = await User.findById(req.userId)
            .select('sEmail sUsername sBio sProfilePicUrl bIsProfileComplete bIsKrakenConnected bIsFoundingMember nKrakenConnectRank dCreatedAt dUpdatedAt')
            .lean();
        if (!oUser) return res.reply(messages.not_found('User'));
        oUser.sProfilePicUrl = aws.formatProfilePicUrlForClient(
            oUser.sProfilePicUrl || '',
            oUser.dUpdatedAt
        );
        return res.reply(messages.successfully('Profile'), oUser);
    } catch (error) {
        return _.catchServerError('user.getProfile', error, res);
    }
};

// GET /user/kraken/status  [Protected]
// Returns whether the user's Kraken connection is still valid (tokens not expired).
controllers.krakenStatus = async (req, res) => {
    try {
        const oUser = await User.findById(req.userId);
        if (!oUser) return res.reply(messages.not_found('User'));
        if (!oUser.bIsKrakenConnected) {
            return res.reply(messages.successfully('Kraken status'), { bIsValid: false });
        }
        const auth = await ensureKrakenAuthForUser(oUser);
        return res.reply(messages.successfully('Kraken status'), { bIsValid: !!auth });
    } catch (error) {
        return _.catchServerError('user.krakenStatus', error, res);
    }
};

controllers.getUserDashboardData = async (req, res) => {
    try {
        const oUser = await User.findById(req.userId)
            .select([
                'sEmail',
                'sUsername',
                'sBio',
                'sProfilePicUrl',
                'bIsProfileComplete',
                'sSubscriptionPlan',
                'eSubscriptionStatus',
                'dSubscriptionStart',
                'dSubscriptionEnd',
                'dCreatedAt',
            ].join(' '))
            .lean();
        if (!oUser) return res.reply(messages.not_found('User'));
        const subscription = subscriptionView(oUser);
        const alerts = subscription.active
            ? await CandleAlert.find()
                .sort({ dSignalCandleCloseTime: -1 })
                .limit(12)
                .lean()
            : [];
        const signals = alerts.map(toLatestSignalView);
        return res.reply(messages.success('User dashboard'), {
            oUser: {
                _id: oUser._id,
                sEmail: oUser.sEmail,
                sUsername: oUser.sUsername || '',
                sBio: oUser.sBio || '',
                sProfilePicUrl: oUser.sProfilePicUrl || '',
                bIsProfileComplete: oUser.bIsProfileComplete,
                dCreatedAt: oUser.dCreatedAt,
            },
            oSubscription: subscription,
            bSignalsLocked: !subscription.active,
            oCurrentSignal: signals[0] || null,
            aSignals: signals,
        });
    } catch (error) {
        return _.catchServerError('dashboard.getUserDashboardData', error, res);
    }
};

// GET /public/passport/:username
const passportPromiseCache = new Map();

controllers.getPublicPassport = async (req, res) => {
    try {
        const username = String(req.params.username || '').trim();
        if (!username) return res.reply(messages.required_field('username'));

        const wantsAllPeriods = req.query.allPeriods === 'true';
        const period = isValidPeriod(req.query.period)
            ? normalizePeriodKey(req.query.period)
            : 'all';
        const cacheKey = wantsAllPeriods
            ? `${username.toLowerCase()}:allPeriods`
            : `${username.toLowerCase()}:${period}`;

        if (passportPromiseCache.has(cacheKey)) {
            try {
                const passport = await passportPromiseCache.get(cacheKey);
                return res.reply(messages.successfully('Passport'), passport);
            } catch (e) {
                if (e.message === 'NOT_FOUND') return res.reply(messages.not_found('Passport'));
                throw e;
            }
        }

        const fetchPromise = (async () => {
            const oUser = await User.findOne({
                sUsername: new RegExp(`^${username}$`, 'i'),
                isDeleted: false,
                isActive: true,
                bIsProfileComplete: true,
            })
                .select(STATS_USER_SELECT)
                .lean();

            if (!oUser) throw new Error('NOT_FOUND');

            repairKrakenConnectedFlag(oUser);
            if (wantsAllPeriods) {
                return buildPassportAllPeriodsResponse(oUser);
            }
            return buildPassportPayload(oUser, period);
        })();

        passportPromiseCache.set(cacheKey, fetchPromise);

        fetchPromise.then(() => {
            setTimeout(() => passportPromiseCache.delete(cacheKey), 30000);
        }).catch(() => {
            passportPromiseCache.delete(cacheKey);
        });

        const passport = await fetchPromise;
        return res.reply(messages.successfully('Passport'), passport);

    } catch (error) {
        if (error.message === 'NOT_FOUND') return res.reply(messages.not_found('Passport'));
        return _.catchServerError('user.getPublicPassport', error, res);
    }
};

// ─── Contact Inquiries ──────────────────────────────────────────────────────
controllers.submitInquiry = async (req, res) => {
    try {
        const { sName, sEmail, sMessage } = req.body;
        if (!sName) return res.reply(messages.not_found('Name'));
        if (!sEmail) return res.reply(messages.not_found('Email'));
        if (!sMessage) return res.reply(messages.not_found('Message'));

        const inquiry = await ContactInquiry.create(
            { sName, sEmail, sMessage }
        );
        return res.reply(messages.successfully('Inquiry submitted'), inquiry);
    } catch (error) {
        return _.catchServerError('user.submitInquiry', error, res);
    }
};

controllers.getMyInquiries = async (req, res) => {
    try {
        const oUser = await User.findById(req.userId).select('sEmail').lean();
        if (!oUser) return res.reply(messages.not_found('User'));

        const { nPage = 1, nLimit = 10 } = req.query;
        const page = Math.max(1, parseInt(nPage));
        const limit = Math.min(50, Math.max(1, parseInt(nLimit)));
        const skip = (page - 1) * limit;

        const [aInquiries, nTotal] = await Promise.all([
            ContactInquiry.find({ sEmail: oUser.sEmail })
                .sort({ dCreatedAt: -1 })
                .skip(skip)
                .limit(limit),
            ContactInquiry.countDocuments({ sEmail: oUser.sEmail }),
        ]);

        return res.reply(messages.success('Inquiry list'), {
            aInquiries,
            nTotal,
            nPage: page,
            nTotalPages: Math.ceil(nTotal / limit),
        });
    } catch (error) {
        return _.catchServerError('user.getMyInquiries', error, res);
    }
};

// ─── Public Contact ────────────────────────────────────────────────────────────

controllers.submitPublicContact = async (req, res) => {
    try {
        const { sName, sEmail, sMessage } = req.body;
        if (!sName) return res.reply(messages.not_found('Name'));
        if (!sEmail) return res.reply(messages.not_found('Email'));
        if (!sMessage) return res.reply(messages.not_found('Message'));

        await ContactInquiry.create({ sName, sEmail, sMessage });

        // Notify admin — fire and forget (don't block the response)
        nodemailer.send(
            'inquiry_notification.html',
            {
                SITE_NAME: config.SITE_NAME,
                SENDER_NAME: sName,
                SENDER_EMAIL: sEmail,
                MESSAGE: sMessage,
            },
            {
                from: config.SMTP_FROM,
                to: config.SMTP_FROM,
                subject: `New inquiry from ${sName}`,
            }
        ).catch(() => {});

        return res.reply(messages.successfully('Message sent'));
    } catch (error) {
        return _.catchServerError('user.submitPublicContact', error, res);
    }
};

// ─── Public Content Endpoints ─────────────────────────────────────────────────

controllers.getPublicFaqs = async (req, res) => {
    try {
        const aFaqs = await Faq.find()
            .select('sQuestion sAnswer sCategory nOrder')
            .sort({ nOrder: 1, dCreatedAt: 1 });
        return res.reply(messages.success('FAQs'), { aFaqs });
    } catch (error) {
        return _.catchServerError('user.getPublicFaqs', error, res);
    }
};

controllers.getPublicFeatures = async (req, res) => {
    try {
        const aFeatures = await Feature.find({ eStatus: 'Active' })
            .select('sTitle sDescription sIconType nOrder')
            .sort({ nOrder: 1, dCreatedAt: 1 });
        return res.reply(messages.success('Features'), { aFeatures });
    } catch (error) {
        return _.catchServerError('user.getPublicFeatures', error, res);
    }
};

controllers.getPublicNews = async (req, res) => {
    try {
        const aArticles = await NewsArticle.find({ eStatus: 'Active' })
            .select('sTitle sExcerpt sTag sDate nReadMinutes bIsFeatured')
            .sort({ bIsFeatured: -1, dCreatedAt: -1 });
        return res.reply(messages.success('News'), { aArticles });
    } catch (error) {
        return _.catchServerError('user.getPublicNews', error, res);
    }
};

/** Public legal/CMS pages — slug maps to admin CMS titles. */
const PUBLIC_CMS_SLUG_TO_TITLE = {
    privacy: 'Privacy Policy',
    terms: 'Terms of Use',
    cookies: 'Cookie Settings',
    about: 'About Us',
    contact: 'Contact Us',
};

controllers.getPublicCms = async (req, res) => {
    try {
        const slug = String(req.params.slug || '')
            .trim()
            .toLowerCase();
        const title = PUBLIC_CMS_SLUG_TO_TITLE[slug];
        if (!title) return res.reply(messages.not_found('CMS page'));

        const cms = await Cms.findOne({ sTitle: title })
            .select('sTitle sDescription dUpdatedAt dCreatedAt')
            .lean();

        if (!cms) {
            return res.reply(messages.success('CMS'), {
                sTitle: title,
                sDescription: '',
                dUpdatedAt: null,
                dCreatedAt: null,
                slug,
            });
        }

        return res.reply(messages.success('CMS'), {
            ...cms,
            slug,
        });
    } catch (error) {
        return _.catchServerError('user.getPublicCms', error, res);
    }
};

/**
 * Build durable passport OG object key (S3). Kept on backend so frontend never needs bucket URL.
 */
function buildPassportOgObjectKey({ username, period, theme, v, rev }) {
    const user =
        String(username || '')
            .replace(/^@/, '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]/g, '')
            .slice(0, 64) || 'trader';
    const safePeriod = String(period || 'all').replace(/[^a-z0-9_-]/gi, '') || 'all';
    const safeTheme = theme === 'light' ? 'light' : 'dark';
    const fp = require('crypto')
        .createHash('sha256')
        .update(String(v || ''))
        .digest('hex')
        .slice(0, 20);
    const assetRev = Number(rev) || 0;
    return `passport-og/r${assetRev}/${user}/${safePeriod}/${safeTheme}/${fp}.png`;
}

function buildPassportOgPublicUrl(key) {
    const base = String(config.S3_BUCKET_URL || '').replace(/\/$/, '');
    if (!base || !key) return null;
    return `${base}/${String(key).replace(/^\//, '')}`;
}

/**
 * GET /public/passport/og-image/url
 * Returns the public S3 URL only when the object exists (HeadObject).
 * Query: username, period, theme, v, rev
 */
controllers.getPassportOgImageUrl = async (req, res) => {
    try {
        if (!aws.isS3Configured()) {
            return res.reply(messages.successfully('Passport OG URL'), {
                url: null,
                skipped: true,
                reason: 'S3 not configured on backend',
            });
        }
        const username = String(req.query.username || '').trim();
        const period = String(req.query.period || 'all').trim();
        const theme = String(req.query.theme || 'dark').trim();
        const v = String(req.query.v || '').trim();
        const rev = req.query.rev;
        if (!username || !v) {
            return res.reply(messages.required_field('username and v'));
        }
        const key = buildPassportOgObjectKey({ username, period, theme, v, rev });
        const exists = await aws.passportOgObjectExists(key);
        const url = exists ? buildPassportOgPublicUrl(key) : null;
        return res.reply(messages.successfully('Passport OG URL'), {
            url,
            key,
            exists,
            skipped: false,
        });
    } catch (error) {
        return _.catchServerError('user.getPassportOgImageUrl', error, res);
    }
};

/** Passport card PNG routes on our own frontend — the only pull sources allowed. */
const PASSPORT_OG_PULL_PATH =
    /^\/passport\/[^/]+\/(dark|light)\/(twitter-card|opengraph-card)(\.png)?$/;

/**
 * Allow pulling a card PNG only from our own frontend origins (SSRF guard).
 * @param {string} imageUrl
 * @returns {string|null} Normalized URL or null when not allowed.
 */
function resolvePassportOgPullUrl(imageUrl) {
    const raw = String(imageUrl || '').trim();
    if (!raw) return null;

    const allowedOrigins = [config.FRONTEND_URL, config.WEB_URL]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .map((value) => {
            try {
                return new URL(value).origin;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
    if (!allowedOrigins.length) return null;

    try {
        const parsed = new URL(raw);
        if (!allowedOrigins.includes(parsed.origin)) return null;
        if (!PASSPORT_OG_PULL_PATH.test(parsed.pathname)) return null;
        return parsed.toString();
    } catch {
        return null;
    }
}

/**
 * Download an already-rendered card PNG from the frontend.
 * @param {string} url
 * @returns {Promise<Buffer>}
 */
async function fetchPassportOgPng(url) {
    const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 25000,
        maxContentLength: 6 * 1024 * 1024,
        headers: { Accept: 'image/png,image/*' },
    });
    const contentType = String(response.headers?.['content-type'] || '');
    if (!contentType.startsWith('image/')) {
        throw new Error(`Unexpected content-type: ${contentType || 'unknown'}`);
    }
    return Buffer.from(response.data);
}

/**
 * POST /public/passport/og-image
 * Next.js server stores a pre-rendered passport OG PNG; S3 secrets stay on the backend.
 *
 * Accepts the image in three ways (smallest request wins):
 *  1. Raw body with `Content-Type: application/octet-stream` + metadata in query.
 *  2. JSON `{ ..., imageUrl }` — backend pulls the PNG from our own frontend.
 *  3. JSON `{ ..., imageBase64 }` — legacy, ~33% larger than the raw PNG.
 *
 * Optional header: x-tinka-og-upload-secret (required when PASSPORT_OG_UPLOAD_SECRET is set)
 */
controllers.uploadPassportOgImage = async (req, res) => {
    try {
        const expectedSecret = String(config.PASSPORT_OG_UPLOAD_SECRET || '').trim();
        if (expectedSecret) {
            const provided = String(req.headers['x-tinka-og-upload-secret'] || '').trim();
            if (!provided || provided !== expectedSecret) {
                return res.reply(messages.unauthorized());
            }
        }

        if (!aws.isS3Configured()) {
            return res.reply(messages.successfully('Passport OG'), {
                skipped: true,
                reason: 'S3 not configured on backend',
                url: null,
            });
        }

        const isBinaryUpload = Buffer.isBuffer(req.body);
        const meta = isBinaryUpload ? req.query : req.body || {};

        const username = String(meta.username || '').trim();
        const period = String(meta.period || 'all').trim();
        const theme = String(meta.theme || 'dark').trim();
        const v = String(meta.v || '').trim();
        const rev = meta.rev;
        const imageBase64 = isBinaryUpload
            ? ''
            : String(req.body?.imageBase64 || '').trim();
        const pullUrl = isBinaryUpload
            ? null
            : resolvePassportOgPullUrl(req.body?.imageUrl);

        if (!username || !v) {
            return res.reply(messages.required_field('username and v'));
        }

        let buffer = null;
        if (isBinaryUpload) {
            buffer = req.body;
        } else if (imageBase64) {
            const raw = imageBase64.includes(',')
                ? imageBase64.slice(imageBase64.indexOf(',') + 1)
                : imageBase64;
            try {
                buffer = Buffer.from(raw, 'base64');
            } catch {
                return res.reply(messages.invalid('imageBase64'));
            }
        } else if (pullUrl) {
            buffer = await fetchPassportOgPng(pullUrl);
        } else if (req.body?.imageUrl) {
            return res.reply(messages.invalid('imageUrl'));
        } else {
            return res.reply(
                messages.required_field('image body, imageUrl or imageBase64')
            );
        }

        const key = buildPassportOgObjectKey({ username, period, theme, v, rev });
        const uploaded = await aws.uploadBufferToS3(buffer, key, 'image/png');
        return res.reply(messages.successfully('Passport OG uploaded'), {
            skipped: false,
            url: uploaded.Location,
            key: uploaded.Key,
        });
    } catch (error) {
        return _.catchServerError('user.uploadPassportOgImage', error, res);
    }
};

module.exports = controllers;
