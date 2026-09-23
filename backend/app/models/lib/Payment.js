const mongoose = require('mongoose');

const Payment = mongoose.Schema(
    {
        oUser: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'users',
            required: true,
            index: true,
        },
        sStripeCheckoutSessionId: {
            type: String,
            required: true,
            unique: true,
            index: true,
        },
        sStripePaymentIntentId: { type: String, default: '' },
        sStripeCustomerId: { type: String, default: '' },
        sPlanId: { type: String, required: true },
        nAmount: { type: Number, required: true },
        sCurrency: { type: String, default: 'inr' },
        eStatus: {
            type: String,
            enum: ['pending', 'paid', 'failed'],
            default: 'pending',
            index: true,
        },
        dPaidAt: { type: Date, default: null },
    },
    { timestamps: { createdAt: 'dCreatedAt', updatedAt: 'dUpdatedAt' } },
);

module.exports = mongoose.model('payments', Payment);
