const multer = require('./multer');

const profileImageInstance = multer.createUploadInstance('image', 5);

const services = {};

services.uploadProfileImage = () => {
    return (req, res, next) => {
        return profileImageInstance(req, res, function (error) {
            if (error) {
                return res.reply(messages.bad_request(error.message));
            }
            return next(null, null);
        });
    };
};

module.exports = services;
