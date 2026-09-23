const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getPlan,
    listPlans,
    addPlanDuration,
    subscriptionView,
} = require('../app/services/billing/plans');

test('billing exposes the three exact INR access plans', () => {
    assert.deepEqual(
        listPlans().map((plan) => [plan.id, plan.amountInr]),
        [
            ['monthly', 199],
            ['quarterly', 599],
            ['annual', 999],
        ],
    );
});

test('plan duration extends from the supplied subscription end', () => {
    const start = new Date('2026-01-15T00:00:00.000Z');
    assert.equal(
        addPlanDuration(start, getPlan('monthly')).toISOString(),
        '2026-02-15T00:00:00.000Z',
    );
    assert.equal(
        addPlanDuration(start, getPlan('quarterly')).toISOString(),
        '2026-04-15T00:00:00.000Z',
    );
    assert.equal(
        addPlanDuration(start, getPlan('annual')).toISOString(),
        '2027-01-15T00:00:00.000Z',
    );
});

test('subscription view never treats an expired record as active', () => {
    const expired = subscriptionView({
        eSubscriptionStatus: 'active',
        sSubscriptionPlan: 'monthly',
        dSubscriptionEnd: new Date(Date.now() - 1000),
    });
    assert.equal(expired.active, false);
    assert.equal(expired.status, 'inactive');
    assert.equal(expired.planId, null);

    const active = subscriptionView({
        eSubscriptionStatus: 'active',
        sSubscriptionPlan: 'annual',
        dSubscriptionEnd: new Date(Date.now() + 60000),
    });
    assert.equal(active.active, true);
    assert.equal(active.planId, 'annual');
});
