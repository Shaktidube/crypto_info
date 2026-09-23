import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../auth/AuthContext';
import Brand from '../components/Brand';

function formatDate(value, withTime = false) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
    }).format(new Date(value));
}

function formatPrice(value) {
    if (!Number.isFinite(Number(value))) return '—';
    return new Intl.NumberFormat('en-IN', {
        maximumFractionDigits: 6,
    }).format(Number(value));
}

function confidence(value) {
    return Number.isFinite(Number(value))
        ? `${Math.round(Number(value) * 100)}%`
        : '—';
}

function SignalDirection({ direction }) {
    const positive = direction === 'bullish';
    return (
        <span className={`direction ${positive ? 'direction--up' : 'direction--down'}`}>
            <span>{positive ? '↗' : '↘'}</span>
            {positive ? 'Long' : 'Short'}
        </span>
    );
}

function SignalCard({ signal, featured = false }) {
    if (!signal) return null;
    const plan = signal.oTradePlan || {};
    return (
        <article className={`signal-card ${featured ? 'signal-card--featured' : ''}`}>
            <div className="signal-card__top">
                <div>
                    <div className="signal-symbol">
                        {signal.sSymbol || signal.sPair}
                        <span>{signal.sTimeframe}</span>
                    </div>
                    <h3>{signal.sPatternName}</h3>
                </div>
                <SignalDirection direction={signal.sDirection} />
            </div>
            <div className="confidence-row">
                <span>Signal confidence</span>
                <strong>{confidence(signal.nConfidence)}</strong>
                <div className="confidence-track">
                    <span style={{ width: confidence(signal.nConfidence) }} />
                </div>
            </div>
            <dl className="price-grid">
                <div><dt>Entry</dt><dd>{formatPrice(plan.entryPrice)}</dd></div>
                <div><dt>Stop loss</dt><dd className="negative">{formatPrice(plan.stopLoss)}</dd></div>
                <div><dt>Target 1</dt><dd className="positive">{formatPrice(plan.takeProfit1)}</dd></div>
                <div><dt>Target 2</dt><dd>{formatPrice(plan.takeProfit2)}</dd></div>
            </dl>
            <div className="signal-meta">
                <span>Trend: {signal.oContext?.trend || 'unknown'}</span>
                <span>{signal.bIsConfirmed ? 'Confirmed' : 'Forming'}</span>
                <time>{formatDate(signal.dSignalCandleCloseTime, true)}</time>
            </div>
        </article>
    );
}

function Pricing({ plans, buying, onBuy, active }) {
    return (
        <section className="pricing-section" id="plans">
            <div className="section-heading">
                <div>
                    <span className="eyebrow">Simple access</span>
                    <h2>{active ? 'Extend your membership' : 'Unlock every live signal'}</h2>
                </div>
                <p>One secure payment. No automatic renewal.</p>
            </div>
            <div className="pricing-grid">
                {plans.map((plan) => {
                    const popular = plan.id === 'annual';
                    return (
                        <article
                            className={`price-card ${popular ? 'price-card--popular' : ''}`}
                            key={plan.id}
                        >
                            {popular && <span className="popular-pill">Best value</span>}
                            <h3>{plan.name}</h3>
                            <div className="price"><sup>₹</sup>{plan.amountInr}</div>
                            <p>{plan.description}</p>
                            <ul>
                                <li>Trend-confirmed current signals</li>
                                <li>Entry, stop and three targets</li>
                                <li>Pattern and confidence context</li>
                            </ul>
                            <button
                                className={`button ${popular ? 'button--primary' : 'button--outline'}`}
                                onClick={() => onBuy(plan.id)}
                                disabled={Boolean(buying)}
                            >
                                {buying === plan.id ? 'Opening checkout…' : 'Choose plan'}
                            </button>
                        </article>
                    );
                })}
            </div>
        </section>
    );
}

export default function DashboardPage() {
    const { token, logout } = useAuth();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [dashboard, setDashboard] = useState(null);
    const [plans, setPlans] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [buying, setBuying] = useState('');

    const loadDashboard = useCallback(async (showSpinner = false) => {
        if (showSpinner) setLoading(true);
        try {
            const [dashboardData, planData] = await Promise.all([
                apiRequest('/user/dashboard', { token }),
                apiRequest('/billing/plans'),
            ]);
            setDashboard(dashboardData);
            setPlans(planData.aPlans || []);
            setError('');
        } catch (requestError) {
            if (requestError.status === 401) {
                await logout();
                navigate('/login', { replace: true });
                return;
            }
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }, [logout, navigate, token]);

    useEffect(() => {
        loadDashboard(true);
        const timer = window.setInterval(() => loadDashboard(false), 30000);
        return () => window.clearInterval(timer);
    }, [loadDashboard]);

    async function buyPlan(planId) {
        setBuying(planId);
        setError('');
        try {
            const data = await apiRequest('/billing/checkout-session', {
                method: 'POST',
                token,
                body: { sPlanId: planId },
            });
            window.location.assign(data.sCheckoutUrl);
        } catch (requestError) {
            setError(requestError.message);
            setBuying('');
        }
    }

    const userName = useMemo(() => {
        const user = dashboard?.oUser;
        if (user?.sUsername) return user.sUsername;
        return user?.sEmail?.split('@')[0] || 'Trader';
    }, [dashboard]);

    const paymentCancelled = searchParams.get('payment') === 'cancelled';
    const subscription = dashboard?.oSubscription;

    if (loading) {
        return (
            <div className="loading-screen">
                <Brand />
                <span className="spinner" />
                <p>Preparing your signal desk…</p>
            </div>
        );
    }

    return (
        <div className="dashboard-shell">
            <aside className="sidebar">
                <Brand compact />
                <nav>
                    <a className="active" href="#overview"><span>⌁</span> Overview</a>
                    <a href="#signals"><span>↗</span> Signals</a>
                    <a href="#plans"><span>◇</span> Membership</a>
                </nav>
                <div className="sidebar__foot">
                    <span className="status-dot" /> System monitoring markets
                </div>
            </aside>

            <main className="dashboard-main" id="overview">
                <header className="topbar">
                    <div>
                        <span className="eyebrow">Signal desk</span>
                        <h1>Good to see you, {userName}</h1>
                    </div>
                    <div className="topbar__actions">
                        {subscription?.active ? (
                            <div className="membership-badge">
                                <span>Active</span>
                                Until {formatDate(subscription.expiresAt)}
                            </div>
                        ) : <span className="membership-badge membership-badge--inactive">No active plan</span>}
                        <button className="avatar" title="Log out" onClick={logout}>
                            {userName.slice(0, 2).toUpperCase()}
                        </button>
                    </div>
                </header>

                {paymentCancelled && (
                    <div className="alert alert--info">
                        Payment was cancelled—nothing was charged.
                        <button onClick={() => setSearchParams({})}>Dismiss</button>
                    </div>
                )}
                {error && <div className="alert alert--error">{error}</div>}

                {subscription?.active ? (
                    <>
                        <section className="metrics-grid">
                            <article>
                                <span>Market status</span>
                                <strong><i className="live-dot" /> Live</strong>
                                <small>Refreshes every 30 seconds</small>
                            </article>
                            <article>
                                <span>Current opportunities</span>
                                <strong>{dashboard.aSignals?.length || 0}</strong>
                                <small>High-quality recent signals</small>
                            </article>
                            <article>
                                <span>Access remaining</span>
                                <strong>{Math.max(0, Math.ceil(
                                    (new Date(subscription.expiresAt) - Date.now()) / 86400000,
                                ))} days</strong>
                                <small>{subscription.planId} membership</small>
                            </article>
                        </section>

                        <section className="current-signal" id="signals">
                            <div className="section-heading">
                                <div>
                                    <span className="eyebrow">Latest setup</span>
                                    <h2>Current signal</h2>
                                </div>
                                <button className="refresh-button" onClick={() => loadDashboard(false)}>
                                    ↻ Refresh
                                </button>
                            </div>
                            {dashboard.oCurrentSignal ? (
                                <SignalCard signal={dashboard.oCurrentSignal} featured />
                            ) : (
                                <div className="empty-state">
                                    <span>⌁</span>
                                    <h3>No qualifying setup right now</h3>
                                    <p>The scanner is waiting for pattern, prior trend and confirmation to align.</p>
                                </div>
                            )}
                        </section>

                        {dashboard.aSignals?.length > 1 && (
                            <section className="recent-signals">
                                <div className="section-heading">
                                    <div><span className="eyebrow">History</span><h2>Recent signals</h2></div>
                                </div>
                                <div className="signals-grid">
                                    {dashboard.aSignals.slice(1).map((signal) => (
                                        <SignalCard key={signal.sId} signal={signal} />
                                    ))}
                                </div>
                            </section>
                        )}
                    </>
                ) : (
                    <section className="locked-hero">
                        <div className="locked-hero__copy">
                            <span className="eyebrow">Membership required</span>
                            <h2>Your signal desk is ready.</h2>
                            <p>
                                Activate a plan to reveal current trend-confirmed
                                signals, entries, invalidation and targets.
                            </p>
                            <a className="button button--primary" href="#plans">View access plans ↓</a>
                        </div>
                        <div className="locked-preview">
                            <div className="lock-icon">◇</div>
                            <div className="blur-line wide" />
                            <div className="blur-line" />
                            <div className="blur-cards"><span /><span /><span /></div>
                            <strong>Signals locked</strong>
                        </div>
                    </section>
                )}

                <Pricing
                    plans={plans}
                    buying={buying}
                    onBuy={buyPlan}
                    active={subscription?.active}
                />
                <footer className="dashboard-footer">
                    Signals are informational and not financial advice. Crypto assets involve risk.
                </footer>
            </main>
        </div>
    );
}
