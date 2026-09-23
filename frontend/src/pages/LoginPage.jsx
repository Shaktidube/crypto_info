import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest, deviceId } from '../api';
import { useAuth } from '../auth/AuthContext';
import Brand from '../components/Brand';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

function ArrowIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M14 7l5 5-5 5" />
        </svg>
    );
}

export default function LoginPage() {
    const googleButton = useRef(null);
    const navigate = useNavigate();
    const { saveSession } = useAuth();
    const [step, setStep] = useState('identity');
    const [email, setEmail] = useState('');
    const [otp, setOtp] = useState('');
    const [remember, setRemember] = useState(true);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    async function beginGoogleLogin(credential) {
        setLoading(true);
        setError('');
        try {
            const data = await apiRequest('/auth/user/google', {
                method: 'POST',
                body: { sIdToken: credential },
            });
            setEmail(data.sEmail);
            setStep('otp');
            setNotice(`We sent a 6-digit code to ${data.sEmail}.`);
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }

    useEffect(() => {
        if (!GOOGLE_CLIENT_ID || step !== 'identity') return undefined;
        let attempts = 0;
        const timer = window.setInterval(() => {
            attempts += 1;
            if (window.google?.accounts?.id && googleButton.current) {
                window.clearInterval(timer);
                window.google.accounts.id.initialize({
                    client_id: GOOGLE_CLIENT_ID,
                    callback: ({ credential }) => beginGoogleLogin(credential),
                    auto_select: false,
                    cancel_on_tap_outside: true,
                });
                googleButton.current.innerHTML = '';
                window.google.accounts.id.renderButton(googleButton.current, {
                    theme: 'outline',
                    size: 'large',
                    width: Math.min(400, googleButton.current.offsetWidth),
                    text: 'continue_with',
                    shape: 'pill',
                });
            }
            if (attempts > 50) window.clearInterval(timer);
        }, 100);
        return () => window.clearInterval(timer);
    }, [step]);

    async function sendEmailOtp(event) {
        event.preventDefault();
        setLoading(true);
        setError('');
        try {
            const data = await apiRequest('/auth/user/send-otp', {
                method: 'POST',
                body: {
                    sEmail: email.trim().toLowerCase(),
                    sDeviceId: deviceId(),
                    bForceOtp: true,
                },
            });
            if (!data.bRequiresOtp && data.sToken) {
                saveSession(data);
                navigate('/dashboard');
                return;
            }
            setStep('otp');
            setNotice(`We sent a 6-digit code to ${email}.`);
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }

    async function verifyOtp(event) {
        event.preventDefault();
        if (otp.length !== 6) return;
        setLoading(true);
        setError('');
        try {
            const session = await apiRequest('/auth/user/verify-otp', {
                method: 'POST',
                body: {
                    sEmail: email,
                    sOtp: otp,
                    bRememberDevice: remember,
                    sDeviceId: deviceId(),
                },
            });
            saveSession(session);
            navigate('/dashboard');
        } catch (requestError) {
            setError(requestError.message);
        } finally {
            setLoading(false);
        }
    }

    return (
        <main className="auth-shell">
            <section className="auth-story">
                <Brand />
                <div className="auth-story__content">
                    <span className="eyebrow">Pattern intelligence, refined</span>
                    <h1>Trade the setup.<br /><em>Not the noise.</em></h1>
                    <p>
                        Trend-confirmed crypto signals with transparent entries,
                        invalidation and risk structure.
                    </p>
                    <div className="mini-chart" aria-hidden="true">
                        <svg viewBox="0 0 600 220" preserveAspectRatio="none">
                            <defs>
                                <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="0" stopColor="#42e8a6" stopOpacity=".28" />
                                    <stop offset="1" stopColor="#42e8a6" stopOpacity="0" />
                                </linearGradient>
                            </defs>
                            <path className="mini-chart__fill" d="M0 190C38 178 54 130 92 147s58 25 88-22 62-75 102-39 50 78 94 39 70-91 112-67 56 39 112-23v185H0Z" />
                            <path className="mini-chart__line" d="M0 190C38 178 54 130 92 147s58 25 88-22 62-75 102-39 50 78 94 39 70-91 112-67 56 39 112-23" />
                        </svg>
                    </div>
                </div>
                <p className="auth-story__foot">Evidence-led signals · No guaranteed returns</p>
            </section>

            <section className="auth-panel">
                <div className="auth-card">
                    <div className="auth-card__mobile-brand"><Brand compact /></div>
                    {step === 'identity' ? (
                        <>
                            <span className="eyebrow">Welcome</span>
                            <h2>Access your signal desk</h2>
                            <p className="muted">Sign in securely, then confirm your email with OTP.</p>

                            {GOOGLE_CLIENT_ID ? (
                                <div ref={googleButton} className="google-button" />
                            ) : (
                                <div className="config-note">
                                    Add <code>VITE_GOOGLE_CLIENT_ID</code> to enable Google login.
                                </div>
                            )}

                            <div className="divider"><span>or use email</span></div>
                            <form onSubmit={sendEmailOtp} className="auth-form">
                                <label htmlFor="email">Email address</label>
                                <input
                                    id="email"
                                    type="email"
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder="you@example.com"
                                    autoComplete="email"
                                    required
                                />
                                <button className="button button--primary" disabled={loading}>
                                    {loading ? 'Sending…' : 'Continue with email'}
                                    {!loading && <ArrowIcon />}
                                </button>
                            </form>
                        </>
                    ) : (
                        <>
                            <button className="back-link" onClick={() => setStep('identity')}>
                                ← Back
                            </button>
                            <span className="eyebrow">Email verification</span>
                            <h2>Enter your code</h2>
                            <p className="muted">{notice}</p>
                            <form onSubmit={verifyOtp} className="auth-form">
                                <label htmlFor="otp">6-digit OTP</label>
                                <input
                                    id="otp"
                                    className="otp-input"
                                    inputMode="numeric"
                                    autoComplete="one-time-code"
                                    maxLength="6"
                                    value={otp}
                                    onChange={(event) => setOtp(
                                        event.target.value.replace(/\D/g, '').slice(0, 6),
                                    )}
                                    placeholder="000000"
                                    autoFocus
                                    required
                                />
                                <label className="check-row">
                                    <input
                                        type="checkbox"
                                        checked={remember}
                                        onChange={(event) => setRemember(event.target.checked)}
                                    />
                                    <span>Trust this device for 30 days</span>
                                </label>
                                <button
                                    className="button button--primary"
                                    disabled={loading || otp.length !== 6}
                                >
                                    {loading ? 'Verifying…' : 'Verify and continue'}
                                    {!loading && <ArrowIcon />}
                                </button>
                                <button
                                    type="button"
                                    className="text-button"
                                    disabled={loading}
                                    onClick={sendEmailOtp}
                                >
                                    Send a new code
                                </button>
                            </form>
                        </>
                    )}
                    {error && <div className="alert alert--error">{error}</div>}
                    <p className="legal">By continuing, you agree to responsible use and understand that signals are not financial advice.</p>
                </div>
            </section>
        </main>
    );
}
