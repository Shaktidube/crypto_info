const mongoose = require('mongoose');

const ContactInquiry = mongoose.Schema(
    {
        sName: { type: String, required: true, trim: true },
        sEmail: { type: String, required: true, trim: true },
        sMessage: { type: String, required: true, trim: true },
        sAdminReply: { type: String, default: '' },
        eStatus: {
            type: String,
            enum: ['Pending', 'Closed'],
            default: 'Pending',
        },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('contactinquiries', ContactInquiry);
