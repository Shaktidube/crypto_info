import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PaymentSuccessPage from './pages/PaymentSuccessPage';
import LandingPage from './pages/LandingPage';

function ProtectedRoute({ children }) {
    const { isAuthenticated } = useAuth();
    return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
    const { isAuthenticated } = useAuth();
    return (
        <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route
                path="/login"
                element={isAuthenticated
                    ? <Navigate to="/dashboard" replace />
                    : <LoginPage />}
            />
            <Route
                path="/dashboard"
                element={(
                    <ProtectedRoute>
                        <DashboardPage />
                    </ProtectedRoute>
                )}
            />
            <Route
                path="/payment/success"
                element={(
                    <ProtectedRoute>
                        <PaymentSuccessPage />
                    </ProtectedRoute>
                )}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
