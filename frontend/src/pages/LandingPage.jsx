import { Link } from 'react-router-dom';
import Brand from '../components/Brand';

const plans = [
    { name: '1 month', price: 199, note: 'Flexible access' },
    { name: '3 months', price: 599, note: 'Quarterly access' },
    { name: '1 year', price: 999, note: 'Best value', featured: true },
];

function Arrow() {
    return <span aria-hidden="true">→</span>;
}

export default function LandingPage() {
    return (
        <main className="landing">
            <nav className="landing-nav" aria-label="Main navigation">
                <Link to="/" aria-label="Crypto Info home"><Brand /></Link>
                <div className="landing-nav__links">
                    <a href="#method">Method</a>
                    <a href="#pricing">Pricing</a>
                    <a href="#faq">FAQ</a>
                </div>
                <Link className="button button--outline landing-nav__login" to="/login">
                    Sign in
                </Link>
            </nav>

            <section className="landing-hero">
                <div className="landing-hero__copy">
                    <span className="landing-kicker"><i /> Markets move. Evidence decides.</span>
                    <h1>Crypto signals built to filter out the noise.</h1>
                    <p>
                        Crypto Info checks candlestick structure, the preceding trend,
                        momentum and price confirmation before a setup reaches your desk.
                    </p>
                    <div className="landing-hero__actions">
                        <Link className="button button--primary" to="/login">
                            Open your signal desk <Arrow />
                        </Link>
                        <a className="button button--quiet" href="#method">See the method</a>
                    </div>
                    <div className="trust-row">
                        <span><b>✓</b> Email OTP security</span>
                        <span><b>✓</b> Transparent risk levels</span>
                        <span><b>✓</b> No auto-renewal</span>
                    </div>
                </div>

                <div className="hero-terminal" aria-label="Example signal preview">
                    <div className="hero-terminal__bar">
                        <span><i /> Live scanner</span>
                        <small>ILLUSTRATIVE EXAMPLE</small>
                    </div>
                    <div className="hero-terminal__chart" aria-hidden="true">
                        <div className="chart-grid" />
                        <svg viewBox="0 0 600 210" preserveAspectRatio="none">
                            <defs>
                                <linearGradient id="landingFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0" stopColor="#42e8a6" stopOpacity=".28" />
                                    <stop offset="1" stopColor="#42e8a6" stopOpacity="0" />
                                </linearGradient>
                            </defs>
                            <path className="hero-area" d="M0 175C65 165 78 127 134 139s64 34 111-12 66-75 112-42 61 55 101 16 74-67 142-81v190H0Z" />
                            <path className="hero-line" d="M0 175C65 165 78 127 134 139s64 34 111-12 66-75 112-42 61 55 101 16 74-67 142-81" />
                        </svg>
                        <span className="chart-entry">Entry</span>
                        <span className="chart-target">TP1</span>
                    </div>
                    <div className="hero-terminal__signal">
                        <div>
                            <small>BTC/USDT · 1m</small>
                            <strong>Bullish Engulfing</strong>
                        </div>
                        <span className="direction direction--up">↗ Long</span>
                    </div>
                    <dl className="terminal-levels">
                        <div><dt>Entry</dt><dd>64,250</dd></div>
                        <div><dt>Stop</dt><dd className="negative">63,790</dd></div>
                        <div><dt>Target 1</dt><dd className="positive">64,940</dd></div>
                    </dl>
                </div>
            </section>

            <section className="landing-strip" aria-label="Analysis factors">
                <span>Pattern structure</span><i />
                <span>Previous trend</span><i />
                <span>Momentum</span><i />
                <span>Price confirmation</span><i />
                <span>Risk plan</span>
            </section>

            <section className="landing-section method-section" id="method">
                <div className="landing-section__intro">
                    <span className="eyebrow">A stricter signal pipeline</span>
                    <h2>A pattern is only the beginning.</h2>
                    <p>
                        Every candidate must pass multiple independent checks. A signal is
                        shown only after the completed candle confirms the setup.
                    </p>
                </div>
                <div className="method-grid">
                    <article><span>01</span><h3>Read the history</h3><p>Measure moving-average direction, price slope, structure and directional efficiency before the pattern.</p></article>
                    <article><span>02</span><h3>Validate the setup</h3><p>Check candle geometry, context alignment, momentum and volume without counting the same evidence twice.</p></article>
                    <article><span>03</span><h3>Wait for confirmation</h3><p>Two-candle patterns need a following closed candle to break through the setup high or low.</p></article>
                    <article><span>04</span><h3>Define the risk</h3><p>Receive a clear entry, structural stop and reward-based targets—never an unexplained buy or sell label.</p></article>
                </div>
            </section>

            <section className="landing-section outcome-section">
                <div>
                    <span className="eyebrow">Clarity at decision time</span>
                    <h2>Know why a setup qualified.</h2>
                </div>
                <div className="outcome-list">
                    <p><b>Context</b><span>Previous trend agrees with the reversal or continuation pattern.</span></p>
                    <p><b>Confirmation</b><span>The next closed candle validates direction before entry.</span></p>
                    <p><b>Invalidation</b><span>A structural stop makes the failure condition explicit.</span></p>
                </div>
            </section>

            <section className="landing-section" id="pricing">
                <div className="landing-section__intro landing-section__intro--center">
                    <span className="eyebrow">Simple prepaid access</span>
                    <h2>One desk. Three durations.</h2>
                    <p>Pay once through Stripe. Your access ends automatically unless you choose to extend it.</p>
                </div>
                <div className="landing-pricing">
                    {plans.map((plan) => (
                        <article className={plan.featured ? 'featured' : ''} key={plan.name}>
                            {plan.featured && <span className="popular-pill">Best value</span>}
                            <small>{plan.name}</small>
                            <div className="price"><sup>₹</sup>{plan.price}</div>
                            <p>{plan.note}</p>
                            <ul>
                                <li>Current high-quality signals</li>
                                <li>Entry, stop and targets</li>
                                <li>Pattern and trend context</li>
                            </ul>
                            <Link className={`button ${plan.featured ? 'button--primary' : 'button--outline'}`} to="/login">
                                Get access <Arrow />
                            </Link>
                        </article>
                    ))}
                </div>
            </section>

            <section className="landing-section faq-section" id="faq">
                <div><span className="eyebrow">Common questions</span><h2>Before you begin.</h2></div>
                <div className="faq-list">
                    <details><summary>Does Crypto Info guarantee profitable trades?</summary><p>No. Signals are analytical information, not financial advice. Every trade can lose money, including a historically successful setup.</p></details>
                    <details><summary>How do I access the dashboard?</summary><p>Continue with Google or your email address, verify the six-digit OTP, then activate one of the prepaid plans.</p></details>
                    <details><summary>Will my plan renew automatically?</summary><p>No. These are one-time payments. You can manually extend access whenever you choose.</p></details>
                    <details><summary>What makes a signal qualify?</summary><p>The engine combines pattern geometry, prior-trend evidence, confirmation, momentum and risk structure. Weak or conflicting setups are filtered out.</p></details>
                </div>
            </section>

            <section className="landing-cta">
                <span className="eyebrow">Ready when the evidence aligns</span>
                <h2>Bring discipline to your signal feed.</h2>
                <Link className="button button--primary" to="/login">Enter Crypto Info <Arrow /></Link>
            </section>

            <footer className="landing-footer">
                <Brand compact />
                <p>Signals are informational and not financial advice. Crypto assets involve substantial risk.</p>
                <span>© {new Date().getFullYear()} Crypto Info</span>
            </footer>
        </main>
    );
}
