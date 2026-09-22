const mongoose = require('mongoose');

const Cms = mongoose.Schema(
    {
        sTitle: {
            type: String,
            required: true,
            unique: true,
            enum: [
                'About Us',
                'Privacy Policy',
                'Terms of Use',
                'Contact Us',
                'Cookie Settings',
            ],
        },
        sDescription: { type: String, default: '' },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('cms', Cms);
