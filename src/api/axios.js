import axios from 'axios';

// In dev: always use relative path so Vite proxy forwards /api to backend (avoids CORS).
// In production: use '/' so Netlify proxies /api/* to backend (no CORS). Set VITE_API_BASE only if backend allows CORS.
const baseURL = import.meta.env.DEV
    ? '/'
    : (import.meta.env.VITE_API_BASE ?? '/');

const api = axios.create({
    baseURL,
});

// When using direct backend URL, paths are "login" not "api/login"
const isDirectBackend = baseURL !== '/' && !baseURL.startsWith('/');
if (isDirectBackend) {
    api.interceptors.request.use((config) => {
        if (typeof config.url === 'string' && config.url.startsWith('api/')) {
            config.url = config.url.slice(4);
        }
        return config;
    });
}

// Add a request interceptor to include the auth token
api.interceptors.request.use(
    (config) => {
        const token = localStorage.getItem('token');
        if (token) {
            config.headers.Authorization = `Bearer ${token}`; // Adjust based on API requirements, usually Bearer
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

export default api;
