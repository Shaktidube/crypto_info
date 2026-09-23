import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
} from 'react';
import { apiRequest, deviceId } from '../api';

const AuthContext = createContext(null);
const TOKEN_KEY = 'Crypto Info_token';

export function AuthProvider({ children }) {
    const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));

    const saveSession = useCallback((session) => {
        if (!session?.sToken) return;
        localStorage.setItem(TOKEN_KEY, session.sToken);
        setToken(session.sToken);
    }, []);

    const logout = useCallback(async () => {
        const currentToken = localStorage.getItem(TOKEN_KEY);
        try {
            if (currentToken) {
                await apiRequest('/auth/user/logout', {
                    method: 'POST',
                    token: currentToken,
                    body: { sDeviceId: deviceId() },
                });
            }
        } catch {
            // Local logout must still succeed when the session already expired.
        } finally {
            localStorage.removeItem(TOKEN_KEY);
            setToken(null);
        }
    }, []);

    const value = useMemo(() => ({
        token,
        isAuthenticated: Boolean(token),
        saveSession,
        logout,
    }), [logout, saveSession, token]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const value = useContext(AuthContext);
    if (!value) throw new Error('useAuth must be used inside AuthProvider');
    return value;
}
