const aws = require('./lib/aws');
const mongodb = require('./lib/mongodb');
const uploader = require('./lib/uploader');
const nodemailer = require('./lib/nodemailer');
const globalCache = require('./lib/node_cache');

module.exports = {
    aws,
    mongodb,
    uploader,
    nodemailer,
    globalCache
};
