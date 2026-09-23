const Stripe = require('stripe');
const config = require('../../../config/config');
const { User, Payment } = require('../../models');
const {
    getPlan,
    listPlans,
    addPlanDuration,
    subscriptionView,
} = require('../../services/billing/plans');

let stripeClient = null;

function getStripe() {
    if (!config.STRIPE_SECRET_KEY) {
        const error = new Error('Stripe is not configured');
        error.statusCode = 503;
        throw error;
    }
    if (!stripeClient) stripeClient = new Stripe(config.STRIPE_SECRET_KEY);
    return stripeClient;
}

function stripeId(value) {
    if (!value) return '';
    return typeof value === 'string' ? value : value.id || '';
}

async function fulfillCheckoutSession(session) {
    if (!session || session.payment_status !== 'paid') return null;
    const plan = getPlan(session.metadata?.planId);
    const userId = session.metadata?.userId || session.client_reference_id;
    if (!plan || !userId) throw new Error('Invalid checkout metadata');
    if (session.currency !== 'inr' ||
        session.amount_total !== plan.amountInr * 100) {
        throw new Error('Checkout amount does not match selected plan');
    }

    const existingPayment = await Payment.findOne({
        sStripeCheckoutSessionId: session.id,
    });
    if (existingPayment?.eStatus === 'paid') return existingPayment;

    const user = await User.findById(userId);
    if (!user) throw new Error('Checkout user not found');

    const alreadyProcessed = (user.aProcessedStripeSessions || [])
        .includes(session.id);
    const now = new Date();
    let subscriptionEnd = user.dSubscriptionEnd
        ? new Date(user.dSubscriptionEnd)
        : now;
    const extendingActivePlan = subscriptionEnd.getTime() >= now.getTime();
    if (!extendingActivePlan) subscriptionEnd = now;

    if (!alreadyProcessed) {
        const nextEnd = addPlanDuration(subscriptionEnd, plan);
        await User.findOneAndUpdate(
            {
                _id: userId,
                aProcessedStripeSessions: { $ne: session.id },
            },
            {
                $set: {
                    sSubscriptionPlan: plan.id,
                    eSubscriptionStatus: 'active',
                    dSubscriptionStart: extendingActivePlan
                        ? user.dSubscriptionStart || now
                        : now,
                    dSubscriptionEnd: nextEnd,
                    sStripeCustomerId: stripeId(session.customer),
                },
                $addToSet: { aProcessedStripeSessions: session.id },
            },
        );
    }

    return Payment.findOneAndUpdate(
        { sStripeCheckoutSessionId: session.id },
        {
            $set: {
                oUser: userId,
                sStripePaymentIntentId: stripeId(session.payment_intent),
                sStripeCustomerId: stripeId(session.customer),
                sPlanId: plan.id,
                nAmount: session.amount_total || plan.amountInr * 100,
                sCurrency: session.currency || 'inr',
                eStatus: 'paid',
                dPaidAt: now,
            },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
    );
}

const controllers = {};

controllers.plans = (req, res) => res.reply(
    messages.successfully('Billing plans'),
    { aPlans: listPlans() },
);

controllers.status = async (req, res) => {
    try {
        const user = await User.findById(req.userId)
            .select('sSubscriptionPlan eSubscriptionStatus dSubscriptionStart dSubscriptionEnd')
            .lean();
        if (!user) return res.reply(messages.not_found('User'));
        return res.reply(messages.successfully('Subscription status'), {
            oSubscription: subscriptionView(user),
        });
    } catch (error) {
        return _.catchServerError('billing.status', error, res);
    }
};

controllers.createCheckoutSession = async (req, res) => {
    try {
        const plan = getPlan(req.body?.sPlanId);
        if (!plan) return res.reply(messages.invalid('Plan'));
        const user = await User.findById(req.userId)
            .select('sEmail sStripeCustomerId');
        if (!user) return res.reply(messages.not_found('User'));

        const stripe = getStripe();
        const customer = user.sStripeCustomerId
            ? { customer: user.sStripeCustomerId }
            : {
                customer_email: user.sEmail,
                customer_creation: 'always',
            };
        const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            ...customer,
            client_reference_id: String(user._id),
            line_items: [{
                quantity: 1,
                price_data: {
                    currency: 'inr',
                    unit_amount: plan.amountInr * 100,
                    product_data: {
                        name: plan.name,
                        description: plan.description,
                    },
                },
            }],
            metadata: {
                userId: String(user._id),
                planId: plan.id,
            },
            payment_intent_data: {
                metadata: {
                    userId: String(user._id),
                    planId: plan.id,
                },
            },
            success_url: `${config.FRONTEND_URL}/payment/success` +
                '?session_id={CHECKOUT_SESSION_ID}',
            cancel_url: `${config.FRONTEND_URL}/dashboard?payment=cancelled`,
        });

        await Payment.findOneAndUpdate(
            { sStripeCheckoutSessionId: session.id },
            {
                $setOnInsert: {
                    oUser: user._id,
                    sPlanId: plan.id,
                    nAmount: plan.amountInr * 100,
                    sCurrency: 'inr',
                    eStatus: 'pending',
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
        );

        return res.reply(messages.successfully('Checkout session'), {
            sSessionId: session.id,
            sCheckoutUrl: session.url,
        });
    } catch (error) {
        if (error.statusCode === 503) {
            return res.status(503).json({ message: error.message, data: {} });
        }
        return _.catchServerError('billing.createCheckoutSession', error, res);
    }
};

controllers.checkoutStatus = async (req, res) => {
    try {
        const stripe = getStripe();
        const session = await stripe.checkout.sessions.retrieve(
            req.params.sessionId,
        );
        const userId = session.metadata?.userId || session.client_reference_id;
        if (String(userId) !== String(req.userId)) {
            return res.reply(messages.permission_denied('Checkout'));
        }
        if (session.payment_status === 'paid') {
            await fulfillCheckoutSession(session);
        }
        const user = await User.findById(req.userId).lean();
        return res.reply(messages.successfully('Checkout status'), {
            sPaymentStatus: session.payment_status,
            oSubscription: subscriptionView(user),
        });
    } catch (error) {
        if (error.statusCode === 503) {
            return res.status(503).json({ message: error.message, data: {} });
        }
        return _.catchServerError('billing.checkoutStatus', error, res);
    }
};

controllers.stripeWebhook = async (req, res) => {
    if (!config.STRIPE_WEBHOOK_SECRET) {
        return res.status(503).json({ message: 'Stripe webhook not configured' });
    }
    let event;
    try {
        event = getStripe().webhooks.constructEvent(
            req.body,
            req.headers['stripe-signature'],
            config.STRIPE_WEBHOOK_SECRET,
        );
    } catch (error) {
        return res.status(400).json({ message: 'Invalid webhook signature' });
    }

    try {
        if (event.type === 'checkout.session.completed' ||
            event.type === 'checkout.session.async_payment_succeeded') {
            await fulfillCheckoutSession(event.data.object);
        } else if (event.type === 'checkout.session.async_payment_failed') {
            await Payment.findOneAndUpdate(
                { sStripeCheckoutSessionId: event.data.object.id },
                { $set: { eStatus: 'failed' } },
            );
        }
        return res.status(200).json({ received: true });
    } catch (error) {
        console.error('[stripe-webhook]', error.message);
        return res.status(500).json({ message: 'Webhook processing failed' });
    }
};

controllers.fulfillCheckoutSession = fulfillCheckoutSession;

module.exports = controllers;
