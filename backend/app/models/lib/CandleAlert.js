const mongoose = require('mongoose');

const CandleAlert = mongoose.Schema(
    {
        sAlertKey: { type: String, required: true, unique: true, index: true },
        sPair: { type: String, required: true, index: true },
        sSymbol: { type: String, required: true },
        sTimeframe: { type: String, required: true, default: '1d' },
        sPatternName: { type: String, required: true },
        sDirection: {
            type: String,
            enum: ['bullish', 'bearish', 'neutral', 'unknown'],
            default: 'unknown',
            index: true,
        },
        sPatternType: { type: String, default: '' },
        nConfidence: { type: Number, default: null, index: true },
        oScores: { type: mongoose.Schema.Types.Mixed, default: null },
        oContext: { type: mongoose.Schema.Types.Mixed, default: null },
        oConfirmation: { type: mongoose.Schema.Types.Mixed, default: null },
        oInvalidation: { type: mongoose.Schema.Types.Mixed, default: null },
        oTradePlan: { type: mongoose.Schema.Types.Mixed, default: null },
        oTradeExecution: { type: mongoose.Schema.Types.Mixed, default: null },
        sExplanation: { type: String, default: '' },
        dSignalCandleOpenTime: { type: Date, required: true },
        dSignalCandleCloseTime: { type: Date, required: true },
        bIsConfirmed: { type: Boolean, default: false },
        oCandles: { type: mongoose.Schema.Types.Mixed, required: true },
        oMetrics: { type: mongoose.Schema.Types.Mixed, required: true },
        eEmailStatus: {
            type: String,
            enum: ['Pending', 'Sending', 'Sent', 'Failed'],
            default: 'Pending',
            index: true,
        },
        nEmailAttempts: { type: Number, default: 0 },
        sEmailError: { type: String, default: '' },
        dEmailSentAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } }
);

module.exports = mongoose.model('candlealerts', CandleAlert);
