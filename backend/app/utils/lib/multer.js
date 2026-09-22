const path = require('path');
const multer = require('multer');
const fs = require('fs');
const enums = require('../../../enum');

const services = {};

services.createUploadInstance = (
    fieldName,
    maxFileSizeInMb
) => {
    const storageDisk = multer.diskStorage({
        destination: (req, file, callback) => {
            const dir = path.join(process.cwd(), 'uploads');
            fs.mkdirSync(dir, { recursive: true });
            callback(null, dir);
        },
        filename: (req, file, callback) => {
            callback(null, new Date().getTime() + '_' + file.originalname);
        },
    });

    const fileFilterDisk = function (req, file, cb) {
        let allowedMimes = [];
        let errMsg =
            'Invalid file type. Only __REPLACE_MSG__ files are allowed';

        allowedMimes = enums.supportedImageType;
        errMsg = errMsg.replace('__REPLACE_MSG__', 'JPG, JPEG, PNG');

        const ext = path.extname(file.originalname || '').toLowerCase();
        const imageExtOk = ['.jpg', '.jpeg', '.png'].includes(ext);
        const looseMime =
            !file.mimetype ||
            file.mimetype === 'application/octet-stream' ||
            file.mimetype === 'binary/octet-stream';

        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else if (file.fieldname === 'image' && looseMime && imageExtOk) {
            // iOS Safari often omits multipart Content-Type even for converted JPEGs.
            cb(null, true);
        } else {
            cb(
                {
                    success: false,
                    message: errMsg,
                },
                false
            );
        }
    };

    const oMulterObjDisk = {
        storage: storageDisk,
        fileFilter: fileFilterDisk,
        limits: {
            fileSize: maxFileSizeInMb * 1024 * 1024, // 10mb
        },
    };

    return multer(oMulterObjDisk).single(fieldName);
};

module.exports = services;
