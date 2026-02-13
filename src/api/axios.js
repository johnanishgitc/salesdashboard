import axios from 'axios';

// Always use same-origin paths so the server proxies to the backend (avoids CORS).
// Dev: Vite proxy. Production: Netlify redirect /api/* -> backend.
const baseURL = '/';

const api = axios.create({
    baseURL,
});

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
