import { useState, useEffect, useRef, useCallback } from 'react';

const PROGRESS_DEBOUNCE_MS = 100;

/**
 * Custom hook to manage the SQLite Web Worker lifecycle.
 * Provides state for status, progress, stats, dashboardData, customCardsData, and error,
 * plus a sendMessage() function to communicate with the worker.
 */
export default function useWorker() {
    const workerRef = useRef(null);
    const [isReady, setIsReady] = useState(false);
    const [status, setStatus] = useState('idle');
    const [progress, setProgress] = useState({ current: 0, total: 0, message: '' });
    const [stats, setStats] = useState(null);
    const [dashboardData, setDashboardData] = useState(null);
    const [customCardsData, setCustomCardsData] = useState(null);
    const [rawData, setRawData] = useState(null);
    const [error, setError] = useState(null);
    const [lastMessage, setLastMessage] = useState(null);

    useEffect(() => {
        const worker = new Worker(
            new URL('../workers/sqlite-worker.js', import.meta.url),
            { type: 'module' }
        );
        workerRef.current = worker;

        let progressTimer = null;
        let pendingProgress = null;

        worker.onmessage = (e) => {
            const msg = e.data;

            switch (msg.type) {
                case 'ready':
                    setIsReady(true);
                    setStatus('ready');
                    break;

                case 'progress':
                    // Debounce progress to avoid rapid re-renders
                    pendingProgress = { current: msg.current, total: msg.total, message: msg.message };
                    if (!progressTimer) {
                        progressTimer = setTimeout(() => {
                            if (pendingProgress) setProgress(pendingProgress);
                            progressTimer = null;
                        }, PROGRESS_DEBOUNCE_MS);
                    }
                    break;

                case 'status':
                    setStatus(msg.status);
                    break;

                case 'stats':
                    setStats(msg.stats);
                    break;

                case 'dashboard_data':
                    setDashboardData(msg.data);
                    break;

                case 'extended_dashboard_data':
                    setDashboardData(prev => prev ? ({ ...prev, extended: msg.data }) : { extended: msg.data });
                    break;

                case 'custom_cards_data':
                    setCustomCardsData(msg.cardsData);
                    break;

                case 'raw_data':
                    setRawData(msg.data);
                    break;

                case 'download_complete':
                    setStatus('ready');
                    setLastMessage(msg); // CacheManagement uses this
                    break;

                case 'update_complete':
                    setStatus('ready');
                    setLastMessage(msg);
                    break;

                case 'clear_complete':
                    setStatus('ready');
                    setStats(null);
                    setDashboardData(null);
                    setCustomCardsData(null);
                    setRawData(null);
                    setLastMessage(msg);
                    break;

                case 'error':
                    setError(msg.message);
                    setStatus('error');
                    break;

                default:
                    break;
            }
        };

        worker.onerror = (err) => {
            console.error('[useWorker] Worker error:', err);
            setError(err.message);
            setStatus('error');
        };

        setStatus('initializing');
        worker.postMessage({ type: 'init' });

        return () => {
            if (progressTimer) clearTimeout(progressTimer);
            worker.terminate();
        };
    }, []);

    const sendMessage = useCallback((type, payload) => {
        if (workerRef.current) {
            setError(null);
            workerRef.current.postMessage({ type, payload });
        }
    }, []);

    return {
        isReady,
        status,
        progress,
        stats,
        dashboardData,
        customCardsData,
        rawData,
        error,
        lastMessage,
        sendMessage,
    };
}
