const PLANS = Object.freeze({
    monthly: Object.freeze({
        id: 'monthly',
        name: '1 Month Access',
        amountInr: 199,
        duration: { months: 1 },
        description: 'Full signal dashboard access for one month.',
    }),
    quarterly: Object.freeze({
        id: 'quarterly',
        name: '3 Month Access',
        amountInr: 599,
        duration: { months: 3 },
        description: 'Full signal dashboard access for three months.',
    }),
    annual: Object.freeze({
        id: 'annual',
        name: '1 Year Access',
        amountInr: 999,
        duration: { years: 1 },
        description: 'Full signal dashboard access for one year.',
    }),
});

function getPlan(planId) {
    return PLANS[String(planId || '').trim().toLowerCase()] || null;
}

function listPlans() {
    return Object.values(PLANS).map((plan) => ({
        id: plan.id,
        name: plan.name,
        amountInr: plan.amountInr,
        description: plan.description,
    }));
}

function addPlanDuration(fromDate, plan) {
    const end = new Date(fromDate);
    if (plan.duration.months) {
        end.setUTCMonth(end.getUTCMonth() + plan.duration.months);
    }
    if (plan.duration.years) {
        end.setUTCFullYear(end.getUTCFullYear() + plan.duration.years);
    }
    return end;
}

function subscriptionView(user) {
    const expiresAt = user?.dSubscriptionEnd
        ? new Date(user.dSubscriptionEnd)
        : null;
    const active = user?.eSubscriptionStatus === 'active' &&
        expiresAt && expiresAt.getTime() > Date.now();
    return {
        status: active ? 'active' : 'inactive',
        active: Boolean(active),
        planId: active ? user.sSubscriptionPlan || null : null,
        startsAt: user.dSubscriptionStart || null,
        expiresAt,
    };
}

module.exports = {
    PLANS,
    getPlan,
    listPlans,
    addPlanDuration,
    subscriptionView,
};
