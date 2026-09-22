const crypto = require('crypto');
const config = require('../../../config/config');

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function hashDeviceId(sDeviceId) {
    return crypto
        .createHmac('sha256', config.JWT_SECRET)
        .update(String(sDeviceId || ''))
        .digest('hex');
}

function getTrustedDevice(user, sDeviceId) {
    if (!user || !sDeviceId) return null;
    const hash = hashDeviceId(sDeviceId);
    return (user.aTrustedDevices || []).find(
        (d) => d.sDeviceHash === hash,
    ) || null;
}

function isTrustedDeviceValid(device) {
    if (!device) return false;
    const now = Date.now();
    if (device.dExpiresAt && new Date(device.dExpiresAt).getTime() < now) {
        return false;
    }
    const inactivityMs = config.OTP_INACTIVITY_DAYS * MS_PER_DAY;
    const lastActive = new Date(
        device.dLastActiveAt || device.dTrustedAt,
    ).getTime();
    if (now - lastActive > inactivityMs) return false;
    return true;
}

function canSkipOtpForDevice(user, sDeviceId) {
    const device = getTrustedDevice(user, sDeviceId);
    return isTrustedDeviceValid(device);
}

function touchTrustedDevice(device) {
    const now = new Date();
    device.dLastActiveAt = now;
    device.dExpiresAt = new Date(
        now.getTime() + config.TRUSTED_DEVICE_SESSION_DAYS * MS_PER_DAY,
    );
}

function registerTrustedDevice(user, sDeviceId) {
    if (!sDeviceId) return;
    const hash = hashDeviceId(sDeviceId);
    const now = new Date();
    const expires = new Date(
        now.getTime() + config.TRUSTED_DEVICE_SESSION_DAYS * MS_PER_DAY,
    );

    if (!Array.isArray(user.aTrustedDevices)) {
        user.aTrustedDevices = [];
    }

    const existing = user.aTrustedDevices.find(
        (d) => d.sDeviceHash === hash,
    );
    if (existing) {
        existing.dTrustedAt = existing.dTrustedAt || now;
        touchTrustedDevice(existing);
        return;
    }

    user.aTrustedDevices.push({
        sDeviceHash: hash,
        dTrustedAt: now,
        dLastActiveAt: now,
        dExpiresAt: expires,
    });

    const maxDevices = config.TRUSTED_DEVICE_MAX_COUNT || 10;
    if (user.aTrustedDevices.length > maxDevices) {
        user.aTrustedDevices.sort(
            (a, b) => new Date(a.dLastActiveAt) - new Date(b.dLastActiveAt),
        );
        user.aTrustedDevices = user.aTrustedDevices.slice(-maxDevices);
    }
}

function removeTrustedDevice(user, sDeviceId) {
    if (!sDeviceId || !Array.isArray(user.aTrustedDevices)) return;
    const hash = hashDeviceId(sDeviceId);
    user.aTrustedDevices = user.aTrustedDevices.filter(
        (d) => d.sDeviceHash !== hash,
    );
}

module.exports = {
    hashDeviceId,
    getTrustedDevice,
    isTrustedDeviceValid,
    canSkipOtpForDevice,
    touchTrustedDevice,
    registerTrustedDevice,
    removeTrustedDevice,
};
