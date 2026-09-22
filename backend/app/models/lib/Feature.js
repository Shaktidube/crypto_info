const mongoose = require('mongoose');

const Feature = mongoose.Schema(
    {
        sTitle: { type: String, required: true, trim: true },
        sDescription: { type: String, required: true, trim: true },
        sIconType: {
            type: String,
            required: true,
            enum: ['verified', 'passport', 'roi', 'win-rate', 'best-asset', 'trade-chart', 'security', 'sync', 'share', 'lock', 'star', 'graph'],
            default: 'star',
        },
        nOrder: { type: Number, default: 0 },
        eStatus: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('features', Feature);
