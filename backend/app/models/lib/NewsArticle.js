const mongoose = require('mongoose');

const NewsArticle = mongoose.Schema(
    {
        sTitle: { type: String, required: true, trim: true },
        sExcerpt: { type: String, required: true, trim: true },
        sTag: { type: String, required: true, trim: true },
        sDate: { type: String, required: true, trim: true },
        nReadMinutes: { type: Number, default: 3 },
        bIsFeatured: { type: Boolean, default: false },
        eStatus: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('newsarticles', NewsArticle);
