const nodemailer = require('nodemailer');
const fs = require('fs');
const ejs = require('ejs');
const path = require('path');
const config = require('../../../config/config');

const transporter = nodemailer.createTransport({
    ...config.MAIL_TRANSPORTER,
    // pool: true,
    // maxConnections: 5,
    // maxMessages: 100,
    // connectionTimeout: 10000,
    // greetingTimeout: 10000,
    // socketTimeout: 15000,
});

const emailTemplatePath = path.join(__dirname, 'dir', 'email_templates');

const services = {};

services.send = async function (templateName, data, mailOption) {
    const template = fs.readFileSync(
        emailTemplatePath + '/' + templateName,
        { encoding: 'utf-8' }
    );
    mailOption.html = ejs.render(template, data);
    return await transporter.sendMail(mailOption);
};

services.sendMail = async function (mailOption) {
    return await transporter.sendMail(mailOption);
};

module.exports = services;
