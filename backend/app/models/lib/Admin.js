const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const config = require('../../../config/config');
const data = require('../../../enum');

const Admin = mongoose.Schema(
    {
        sUserName: {
            type: String,
            default: '',
        },
        sEmail: {
            type: String,
            unique: true,
        },
        sHash: String,
        sToken: {
            type: String,
            default: '',
        },
        eAdminType: {
            type: String,
            default: 'SUB',
            enum: data.adminType, // Require enums from enum.js files
        },
        sResetPasswordToken: String,
        sResetPasswordExpires: String,
        nContactNumber: Number,
        sProfilePicUrl: String,
        isDeleted: {
            type: Boolean,
            default: false
        },
        isActive: {
            type: Boolean,
            default: true
        }
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

Admin.index({ sEmail: 1 });


Admin.statics.findByToken = function (token) {
    const admin = this;
    let decoded;
    try {
        decoded = jwt.verify(token, config.JWT_SECRET);
    } catch (e) {
        return Promise.reject(e);
    }
    const query = {
        _id: decoded._id,
        sToken: token,
    };
    return admin.findOne(query);
};

/**
 *  Use 's' in collection name
 *  Collection name should be in small case
 *  Use '-' instead of space
 */ 

module.exports = mongoose.model('admins', Admin);
