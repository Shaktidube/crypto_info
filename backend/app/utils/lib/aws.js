const path = require('path');
const fs = require('fs');
const {
    S3Client,
    PutObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');
const jimp = require('jimp');
const config = require('../../../config/config');

const PLACEHOLDER_KEYS = new Set(['your aws accessKey', 'your aws secretAccessKey']);
const S3_UPLOAD_TIMEOUT_MS = 30_000;

const s3 = new S3Client({
    credentials: {
        accessKeyId: config.AWS_ACCESS_KEY,
        secretAccessKey: config.AWS_SECRET_KEY,
    },
    region: config.S3_REGION,
    maxAttempts: 3,
});

const services = {};

function trimEnv(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function readAwsAccessKey() {
    return (
        trimEnv(config.AWS_ACCESS_KEY)
    );
}

function readAwsSecretKey() {
    return (
        trimEnv(config.AWS_SECRET_KEY)
    );
}

function extensionFromMime(mimetype, originalname) {
    const fromName = path.extname(originalname || '').toLowerCase();
    if (fromName === '.png' || fromName === '.jpg' || fromName === '.jpeg') {
        return fromName === '.jpeg' ? '.jpg' : fromName;
    }
    if (mimetype === 'image/png') return '.png';
    return '.jpg';
}

function buildS3PublicUrl(key) {
    const bucketUrl = config.S3_BUCKET_URL?.trim();
    if (bucketUrl && bucketUrl.startsWith('http')) {
        return `${bucketUrl.replace(/\/$/, '')}/${key}`;
    }

    const region = config.S3_REGION || 'us-east-1';
    const bucket = config.S3_BUCKET_NAME;
    return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

function normalizePublicBaseUrl(raw) {
    if (!raw) return '';
    let url = raw.trim().replace(/\/$/, '');
    if (url.endsWith('/api/v1')) {
        url = url.slice(0, -'/api/v1'.length);
    }
    return url;
}

function getPublicBaseUrl(req) {
    const fromConfig = normalizePublicBaseUrl(config.BACKEND_PUBLIC_URL);
    if (fromConfig) return fromConfig;

    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http')
        .toString()
        .split(',')[0]
        .trim();
    const host = (req.headers['x-forwarded-host'] || req.get('host') || '')
        .toString()
        .split(',')[0]
        .trim();
    const base = `${proto}://${host}`;

    const isLocalHost =
        host.startsWith('localhost') || host.startsWith('127.0.0.1');
    if (isLocalHost) {
        // eslint-disable-next-line no-console
        console.warn(
            '[aws] Saving profile image URL with localhost. Set BACKEND_PUBLIC_URL on staging/production.'
        );
    }

    return base;
}

services.isS3Configured = function isS3Configured() {
    const accessKey = readAwsAccessKey();
    const secretKey = readAwsSecretKey();
    const bucket = trimEnv(config.S3_BUCKET_NAME);

    return (
        accessKey.length > 0 &&
        secretKey.length > 0 &&
        bucket.length > 0 &&
        !PLACEHOLDER_KEYS.has(accessKey) &&
        !PLACEHOLDER_KEYS.has(secretKey)
    );
};

services.getS3ConfigHint = function getS3ConfigHint() {
    const missing = [];
    const accessKey = readAwsAccessKey();
    const secretKey = readAwsSecretKey();

    if (!accessKey || PLACEHOLDER_KEYS.has(accessKey)) {
        missing.push('AWS_ACCESS_KEY');
    }
    if (!secretKey || PLACEHOLDER_KEYS.has(secretKey)) {
        missing.push('AWS_SECRET_KEY');
    }
    if (!trimEnv(config.S3_BUCKET_NAME)) {
        missing.push('S3_BUCKET_NAME');
    }
    if (!trimEnv(config.S3_REGION)) {
        missing.push('S3_REGION (recommended)');
    }
    return missing;
};

services.formatAwsUploadError = function formatAwsUploadError(err) {
    const message = err?.message || String(err);
    if (message.includes('Access Key Id you provided does not exist')) {
        return 'Invalid AWS_ACCESS_KEY — check the key in your backend .env and restart the server.';
    }
    if (message.includes('SignatureDoesNotMatch')) {
        return 'Invalid AWS_SECRET_KEY — secret does not match the access key.';
    }
    if (message.includes('NoSuchBucket')) {
        return 'S3 bucket not found — check S3_BUCKET_NAME and S3_REGION.';
    }
    if (message.includes('AccessDenied')) {
        return 'AWS access denied — IAM user needs s3:PutObject permission on the bucket.';
    }
    if (message.includes('timed out')) {
        return message;
    }
    return message;
};

async function s3SendWithTimeout(command, operation, timeoutMs = S3_UPLOAD_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await s3.send(command, { abortSignal: controller.signal });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(
                `S3 ${operation} timed out after ${timeoutMs / 1000}s — check network access, S3_REGION (${config.S3_REGION}), and S3_BUCKET_NAME.`
            );
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

services.uploadFileToS3 = async (ObjFile, id, folderName, thumb = true) => {
    let fileBuffer = fs.readFileSync(ObjFile.path);

    if (thumb) {
        const jimpImage = await jimp.read(fileBuffer);
        fileBuffer = await jimpImage
            .scaleToFit(100, 100)
            .getBufferAsync(ObjFile.mimetype);
    }

    let filePath = `${folderName}/${id}`;

    const subName = trimEnv(config.S3_BUCKET_SUB_NAME);
    if (subName) {
        filePath = `${subName}/${filePath}`;
    }

    // PutObject is more reliable than multipart Upload for small profile images.
    await s3SendWithTimeout(
        new PutObjectCommand({
            Bucket: config.S3_BUCKET_NAME,
            Key: filePath,
            Body: fileBuffer,
            ContentType: ObjFile.mimetype,
            CacheControl: 'public, max-age=31536000',
        }),
        `put s3://${config.S3_BUCKET_NAME}/${filePath}`
    );

    const location = buildS3PublicUrl(filePath);

    return {
        Key: filePath,
        Location: location,
    };
};

/**
 * Upload a raw buffer (e.g. passport OG PNG) to S3.
 * @param {Buffer} buffer
 * @param {string} key - Full object key (e.g. passport-og/r34/user/all/dark/abc.png)
 * @param {string} [contentType='image/png']
 * @returns {Promise<{ Key: string, Location: string }>}
 */
/**
 * True only when the object exists (authenticated HeadObject).
 * Missing keys must not be treated as reachable public URLs.
 */
services.passportOgObjectExists = async (key) => {
    if (!services.isS3Configured()) return false;
    const safeKey = String(key || '')
        .replace(/^\/+/, '')
        .replace(/\.\./g, '');
    if (!safeKey || !safeKey.startsWith('passport-og/')) return false;

    try {
        await s3SendWithTimeout(
            new HeadObjectCommand({
                Bucket: config.S3_BUCKET_NAME,
                Key: safeKey,
            }),
            `head s3://${config.S3_BUCKET_NAME}/${safeKey}`,
            2500
        );
        return true;
    } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        if (
            status === 404 ||
            err?.name === 'NotFound' ||
            err?.name === 'NoSuchKey' ||
            err?.Code === 'NotFound' ||
            err?.Code === 'NoSuchKey'
        ) {
            return false;
        }
        // eslint-disable-next-line no-console
        console.warn(
            `[aws] HeadObject failed for ${safeKey}:`,
            err?.message || err
        );
        return false;
    }
};

services.uploadBufferToS3 = async (buffer, key, contentType = 'image/png') => {
    if (!services.isS3Configured()) {
        throw new Error(services.getS3ConfigHint() || 'S3 is not configured');
    }
    const safeKey = String(key || '')
        .replace(/^\/+/, '')
        .replace(/\.\./g, '');
    if (!safeKey || !safeKey.startsWith('passport-og/')) {
        throw new Error('Invalid S3 key for passport OG upload');
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < 64) {
        throw new Error('Invalid image buffer');
    }
    // ~5MB hard cap for OG PNGs
    if (buffer.length > 5 * 1024 * 1024) {
        throw new Error('Image too large');
    }

    await s3SendWithTimeout(
        new PutObjectCommand({
            Bucket: config.S3_BUCKET_NAME,
            Key: safeKey,
            Body: buffer,
            ContentType: contentType || 'image/png',
            CacheControl: 'public, max-age=31536000, immutable',
        }),
        `put s3://${config.S3_BUCKET_NAME}/${safeKey}`
    );

    return {
        Key: safeKey,
        Location: buildS3PublicUrl(safeKey),
    };
};

services.normalizeStoredProfilePicUrl = function 
normalizeStoredProfilePicUrl(url) {
    if (!url || typeof url !== 'string') return url || '';
    const withoutQuery = url.split('?')[0];
    return withoutQuery.replace(/\/uploads\/profile-pic\//g, '/api/v1/public/profile-pic/');
};

/** Append ?v= so browsers refetch after re-upload (same S3/local path per userId). */
services.appendProfilePicCacheBust = function appendProfilePicCacheBust(url, version) {
    if (!url || typeof url !== 'string') return url || '';
    const base = url.split('?')[0];
    if (version == null) return base;
    const ts = version instanceof Date ? version.getTime() : Number(version);
    if (!Number.isFinite(ts) || ts <= 0) return base;
    return `${base}?v=${Math.floor(ts)}`;
};

services.formatProfilePicUrlForClient = function formatProfilePicUrlForClient(url, updatedAt) {
    const normalized = services.normalizeStoredProfilePicUrl(url || '');
    if (!normalized) return '';
    return services.appendProfilePicCacheBust(normalized, updatedAt);
};

services.getProfilePicFilePath = function getProfilePicFilePath(filename) {
    const safe = path.basename(filename || '');
    if (!/^[\da-f]{24}\.(jpe?g|png)$/i.test(safe)) return null;
    return path.join(process.cwd(), 'uploads', 'profile-pic', safe);
};

function getLocalProfilePicDir() {
    return path.join(process.cwd(), 'uploads', 'profile-pic');
}

services.buildLocalProfilePicPublicUrl = function 
buildLocalProfilePicPublicUrl(req, filename) {
    return `${getPublicBaseUrl(req)}/api/v1/public/profile-pic/${filename}`;
};

services.deleteLocalProfilePicFiles = function 
deleteLocalProfilePicFiles(userId) {
    const dir = getLocalProfilePicDir();
    for (const ext of ['.jpg', '.jpeg', '.png']) {
        const filePath = path.join(dir, `${userId}${ext}`);
        if (fs.existsSync(filePath)) {
            fs.unlink(filePath, (err) => {
                if (err) {
                    // eslint-disable-next-line no-console
                    console.warn('[aws] failed to delete local profile pic:', filePath);
                }
            });
        }
    }
};

services.deleteUploadTempFile = function deleteUploadTempFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    fs.unlink(filePath, (err) => {
        if (err) {
            // eslint-disable-next-line no-console
            console.warn('[aws] failed to delete temp upload:', filePath);
        }
    });
};

services.cleanupAfterProfileUpload = function cleanupAfterProfileUpload({
    file,
    userId,
    uploadedToS3,
}) {
    services.deleteUploadTempFile(file?.path);
    if (uploadedToS3 && userId) {
        services.deleteLocalProfilePicFiles(userId);
    }
};

async function uploadProfilePicToS3(file, userId) {
    const ext = extensionFromMime(file.mimetype, file.originalname);
    try {
        // console.log('aws uploads3');
        const uploaded = await services.uploadFileToS3(file, `${userId}${ext}`, 'profile-pic');
        const subName = trimEnv(config.S3_BUCKET_SUB_NAME);
        const key =
            uploaded?.Key ||
            (subName
                ? `${subName}/profile-pic/${userId}${ext}`
                : `profile-pic/${userId}${ext}`);

        return uploaded?.Location || buildS3PublicUrl(key);
    } catch (err) {
        const friendly = services.formatAwsUploadError(err);
        const error = new Error(friendly);
        error.cause = err;
        throw error;
    }
}

async function uploadProfilePicToLocal(file, userId, req) {
    const ext = extensionFromMime(file.mimetype, file.originalname);
    const uploadsDir = getLocalProfilePicDir();
    fs.mkdirSync(uploadsDir, { recursive: true });

    const filename = `${userId}${ext}`;
    const dest = path.join(uploadsDir, filename);
    fs.copyFileSync(file.path, dest);

    return services.buildLocalProfilePicPublicUrl(req, filename);
}

services.uploadProfileImage = async function 
uploadProfileImage(file, userId, req) {
    if (services.isS3Configured()) {
        // console.log('[aws] Uploading profile image to S3 for userId:', file, userId);
        return uploadProfilePicToS3(file, userId);
    }

    const missing = services.getS3ConfigHint();
    if (missing.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(
            `[aws] S3 skipped (missing: ${missing.join(', ')}). Using local disk storage.`
        );
    }

    return uploadProfilePicToLocal(file, userId, req);
};

services.deleteSingleFileFromS3 = async (key) => {
    await s3SendWithTimeout(
        new DeleteObjectCommand({
            Bucket: config.S3_BUCKET_NAME,
            Key: key,
        }),
        `delete s3://${config.S3_BUCKET_NAME}/${key}`
    );
};

services.deleteMultipleFilesFromS3 = async (keyArr) => {
    await s3SendWithTimeout(
        new DeleteObjectsCommand({
            Bucket: config.S3_BUCKET_NAME,
            Delete: {
                Objects: keyArr,
            },
        }),
        `delete multiple objects in s3://${config.S3_BUCKET_NAME}`
    );
};

module.exports = services;
