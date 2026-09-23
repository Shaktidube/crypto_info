import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { apiRequest } from '../api';
import { useAuth } from '../auth/AuthContext';
import Brand from '../components/Brand';

export default function PaymentSuccessPage() {
    const { token } = useAuth();
    const [params] = useSearchParams();
    const [status, setStatus] = useState('checking');
    const [message, setMessage] = useState('Confirming your payment securely…');
    const sessionId = params.get('session_id');

    useEffect(() => {
        if (!sessionId) {
            setStatus('error');
            setMessage('The checkout session is missing.');
            return;
        }
        apiRequest(`/billing/checkout-session/${encodeURIComponent(sessionId)}`, {
            token,
        }).then((data) => {
            if (data.sPaymentStatus === 'paid' && data.oSubscription?.active) {
                setStatus('success');
                setMessage('Your signal access is active.');
            } else {
                setStatus('pending');
                setMessage('Payment is still processing. Refresh in a moment.');
            }
        }).catch((error) => {
            setStatus('error');
            setMessage(error.message);
        });
    }, [sessionId, token]);

    return (
        <main className="payment-page">
            <Brand />
            <section className="payment-result">
                <div className={`payment-result__icon payment-result__icon--${status}`}>
                    {status === 'checking' ? <span className="spinner" /> : status === 'success' ? '✓' : '!' }
                </div>
                <span className="eyebrow">Stripe checkout</span>
                <h1>{status === 'success' ? 'You’re all set.' : 'Payment status'}</h1>
                <p>{message}</p>
                <Link className="button button--primary" to="/dashboard">
                    Open signal dashboard →
                </Link>
            </section>
        </main>
    );
}
