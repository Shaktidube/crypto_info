const API_URL = (import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/, '');

export async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = options.token;
    if (token) headers.set('Authorization', `Bearer ${token}`);
    if (options.body && !(options.body instanceof FormData)) {
        headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(`${API_URL}${path}`, {
        ...options,
        headers,
        body: options.body && !(options.body instanceof FormData)
            ? JSON.stringify(options.body)
            : options.body,
    });
    const payload = await response.json().catch(() => ({
        message: 'The server returned an unreadable response.',
        data: {},
    }));
    if (!response.ok) {
        const error = new Error(payload.message || 'Request failed');
        error.status = response.status;
        error.data = payload.data;
        throw error;
    }
    return payload.data;
}

export function deviceId() {
    const key = 'Crypto Info_device_id';
    let value = localStorage.getItem(key);
    if (!value) {
        value = crypto.randomUUID();
        localStorage.setItem(key, value);
    }
    return value;
}
