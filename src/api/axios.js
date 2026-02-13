import axios from 'axios';

const api = axios.create({
    baseURL: '/', // Use relative path to trigger Vite proxy
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
