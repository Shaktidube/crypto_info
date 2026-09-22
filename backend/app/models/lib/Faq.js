const mongoose = require('mongoose');

const Faq = mongoose.Schema(
    {
        sQuestion: { type: String, required: true, trim: true },
        sAnswer: { type: String, required: true, trim: true },
        sCategory: { type: String, default: 'General', trim: true },
        nOrder: { type: Number, default: 0 },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('faqs', Faq);
