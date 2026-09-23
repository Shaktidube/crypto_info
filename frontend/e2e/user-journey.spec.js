import { expect, test } from '@playwright/test';

test('landing, OTP, current signal and checkout success journey', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', {
        name: 'Crypto signals built to filter out the noise.',
    })).toBeVisible();
    await expect(page.getByText('₹999')).toBeVisible();

    await page.getByRole('link', { name: /Open your signal desk/i }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByLabel('Email address').fill('qa@example.com');
    await page.getByRole('button', { name: /Continue with email/i }).click();
    await expect(page.getByText('We sent a 6-digit code')).toBeVisible();
    await page.getByLabel('6-digit OTP').fill('123456');
    await page.getByRole('button', { name: /Verify/i }).click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Current signal' })).toBeVisible();
    await expect(page.getByText('Bullish Engulfing')).toBeVisible();
    await expect(page.getByText('BTC/USDT')).toBeVisible();

    await page.locator('.price-card', { hasText: '1 Year' })
        .getByRole('button', { name: 'Choose plan' }).click();
    await expect(page).toHaveURL(/\/payment\/success\?session_id=cs_e2e_paid/);
    await expect(page.getByRole('heading', { name: 'You’re all set.' })).toBeVisible();
    await expect(page.getByText('Your signal access is active.')).toBeVisible();
    await page.getByRole('link', { name: /Open signal dashboard/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
});

test('landing is usable at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('heading', {
        name: 'Crypto signals built to filter out the noise.',
    })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
});
