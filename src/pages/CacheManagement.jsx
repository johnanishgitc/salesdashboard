import React, { useState, useEffect } from 'react';
import useWorker from '../hooks/useWorker';
import {
    Download,
    RefreshCw,
    Trash2,
    Database,
    Calendar,
    Activity,
    CheckCircle2,
    AlertCircle,
    Loader2,
    HardDrive,
    LayoutGrid,
    FileJson,
    Eye,
    Clock,
} from 'lucide-react';

const CacheManagement = () => {
    const { isReady, status, progress, stats, dashboardData, rawData, error, lastMessage, sendMessage } = useWorker();
    const company = JSON.parse(localStorage.getItem('selectedCompany') || '{}');
    const token = localStorage.getItem('token');

    const [fromDate, setFromDate] = useState('2025-04-01');
    const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);
    const [toast, setToast] = useState(null);
    const [cardCount, setCardCount] = useState(null);
    const [cards, setCards] = useState([]);
    const [showCardsModal, setShowCardsModal] = useState(false);
    const [showJsonModal, setShowJsonModal] = useState(false);
    const [rawDataPage, setRawDataPage] = useState(0);
    const RAW_PAGE_SIZE = 50;

    // Fetch stats + dashboard data when ready
    useEffect(() => {
        if (isReady && company.guid) {
            sendMessage('get_stats', { guid: company.guid });
            sendMessage('get_dashboard_data', {
                guid: company.guid,
                fromDate: fromDate.replace(/-/g, ''),
                toDate: toDate.replace(/-/g, ''),
            });
        }
    }, [isReady, company.guid, sendMessage, fromDate, toDate]);

    // Fetch card count from API
    useEffect(() => {
        const fetchCards = async () => {
            if (!company.guid) return;
            try {
                const tallylocId = company.tallyloc_id || company.tallyLocId || '';
                const url = `/api/dashboard/cards?dashboardType=sales&tallylocId=${tallylocId}&coGuid=${company.guid}&isActive=true`;
                const res = await fetch(url, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                const json = await res.json();
                if (json.status === 'success' && json.data) {
                    const activeCards = json.data.filter(c => c.title !== '__DASHBOARD_SETTINGS__' && c.isActive);
                    setCardCount(activeCards.length);
                    setCards(json.data);
                }
            } catch (err) {
                console.warn('[CacheManagement] Could not fetch cards:', err);
                setCardCount(0);
            }
        };
        fetchCards();
    }, [company.guid, token]);

    // Refresh stats after operations
    useEffect(() => {
        if (
            lastMessage &&
            (lastMessage.type === 'download_complete' ||
                lastMessage.type === 'update_complete' ||
                lastMessage.type === 'clear_complete')
        ) {
            setToast(lastMessage.message);
            sendMessage('get_stats', { guid: company.guid });
            setTimeout(() => setToast(null), 5000);
        }
    }, [lastMessage, company.guid, sendMessage]);

    const formatDate = (dateStr) => dateStr.replace(/-/g, '');

    const formatDisplayDate = (yyyymmdd) => {
        if (!yyyymmdd || yyyymmdd === 'N/A' || yyyymmdd.length < 8) return yyyymmdd;
        return `${yyyymmdd.substring(0, 4)}-${yyyymmdd.substring(4, 6)}-${yyyymmdd.substring(6, 8)}`;
    };

    const formatSize = (totalRecords) => {
        // Rough estimate: ~1KB per record across all tables
        const totalRows = (stats?.totalVouchers || 0) + (stats?.totalLedgerEntries || 0) + (stats?.totalInventoryEntries || 0);
        const sizeKB = totalRows; // ~1KB per row rough estimate
        if (sizeKB >= 1024) return `${(sizeKB / 1024).toFixed(2)} MB (${sizeKB.toLocaleString()} KB)`;
        return `${sizeKB.toLocaleString()} KB`;
    };

    const formatSyncTime = (isoString) => {
        if (!isoString || isoString === 'Never') return 'Never';
        const d = new Date(isoString);
        const now = new Date();
        const diffMs = now - d;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHrs = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let relativeTime;
        if (diffMins < 1) relativeTime = 'Just now';
        else if (diffMins < 60) relativeTime = `${diffMins}m ago`;
        else if (diffHrs < 24) relativeTime = `${diffHrs}h ago`;
        else if (diffDays === 0) relativeTime = 'Today';
        else if (diffDays === 1) relativeTime = 'Yesterday';
        else relativeTime = `${diffDays}d ago`;

        return `${relativeTime}`;
    };

    const handleDownload = () => {
        if (!company.guid) return;
        sendMessage('download', {
            tallyloc_id: company.tallyloc_id,
            company: company.company,
            guid: company.guid,
            fromdate: formatDate(fromDate),
            todate: formatDate(toDate),
            token,
        });
    };

    const handleUpdate = () => {
        if (!company.guid) return;
        sendMessage('update', {
            tallyloc_id: company.tallyloc_id,
            company: company.company,
            guid: company.guid,
            token,
        });
    };

    const handleClear = () => {
        if (!company.guid) return;
        if (window.confirm('Are you sure you want to clear all cached data? This cannot be undone.')) {
            sendMessage('clear', { guid: company.guid });
        }
    };

    const isBusy = status === 'downloading' || status === 'updating' || status === 'initializing';
    const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

    return (
        <div className="space-y-6">
            {/* Header */}
            <div>
                <h1 className="text-2xl font-bold text-gray-900">Cache Management</h1>
                <p className="text-gray-500 mt-1">
                    Download and manage sales data for{' '}
                    <span className="font-semibold text-blue-600">{company.company || 'Unknown'}</span>
                </p>
            </div>

            {/* Toast */}
            {toast && (
                <div className="bg-green-50 border border-green-200 text-green-800 px-4 py-3 rounded-lg flex items-center gap-2 animate-pulse">
                    <CheckCircle2 size={18} />
                    <span>{toast}</span>
                </div>
            )}

            {/* Error */}
            {error && (
                <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded-lg flex items-center gap-2">
                    <AlertCircle size={18} />
                    <span>{error}</span>
                </div>
            )}

            {/* Progress Bar */}
            {isBusy && (
                <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-3">
                        <Loader2 size={20} className="animate-spin text-blue-600" />
                        <span className="text-sm font-medium text-gray-700">
                            {status === 'initializing' ? 'Initializing database...' : progress.message}
                        </span>
                    </div>
                    {progress.total > 0 && (
                        <>
                            <div className="w-full bg-gray-200 rounded-full h-3">
                                <div
                                    className="bg-blue-600 h-3 rounded-full transition-all duration-300"
                                    style={{ width: `${progressPercent}%` }}
                                />
                            </div>
                            <div className="flex justify-between mt-2 text-xs text-gray-500">
                                <span>Chunk {progress.current} of {progress.total}</span>
                                <span>{progressPercent}%</span>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ─── Cache Info Card (like the screenshot) ─────────────── */}
            {stats && (
                <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                    <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-100 bg-gray-50">
                        <div className="bg-purple-100 p-2 rounded-lg">
                            <Activity size={20} className="text-purple-600" />
                        </div>
                        <h3 className="font-semibold text-gray-900">Cache Statistics</h3>
                    </div>

                    {/* Main Info Row */}
                    <div className="px-6 py-5">
                        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 items-start">
                            {/* Type / Name */}
                            <div className="space-y-1">
                                <span className="inline-block bg-blue-100 text-blue-700 text-xs font-semibold px-2.5 py-1 rounded-md">Sales</span>
                                <p className="text-xs text-gray-500 font-mono break-all leading-relaxed mt-1" title={company.guid}>
                                    {company.company || 'N/A'}
                                </p>
                                <p className="text-[10px] text-gray-400 font-mono break-all">{company.guid?.substring(0, 20)}...</p>
                            </div>

                            {/* Date Range */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-1 text-gray-400 text-xs font-medium">
                                    <Calendar size={12} />
                                    <span>Date Range</span>
                                </div>
                                <p className="text-sm font-semibold text-gray-800">
                                    {formatDisplayDate(stats.dateRange.min)}
                                </p>
                                <p className="text-xs text-gray-400">to</p>
                                <p className="text-sm font-semibold text-gray-800">
                                    {formatDisplayDate(stats.dateRange.max)}
                                </p>
                            </div>

                            {/* Size */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-1 text-gray-400 text-xs font-medium">
                                    <HardDrive size={12} />
                                    <span>Estimated Size</span>
                                </div>
                                <p className="text-lg font-bold text-gray-900">{formatSize()}</p>
                            </div>

                            {/* Last Sync */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-1 text-gray-400 text-xs font-medium">
                                    <Clock size={12} />
                                    <span>Last Sync</span>
                                </div>
                                <p className="text-lg font-bold text-emerald-600">{formatSyncTime(stats.lastSync)}</p>
                                <p className="text-[10px] text-gray-400">
                                    {stats.lastSync !== 'Never' ? new Date(stats.lastSync).toLocaleString() : ''}
                                </p>
                            </div>

                            {/* Card Count */}
                            <div className="space-y-1">
                                <div className="flex items-center gap-1 text-gray-400 text-xs font-medium">
                                    <LayoutGrid size={12} />
                                    <span>Dashboard Cards</span>
                                </div>
                                <p className="text-lg font-bold text-gray-900">
                                    {cardCount !== null ? `${cardCount} cards` : <Loader2 size={16} className="animate-spin text-gray-400" />}
                                </p>
                            </div>

                            {/* Actions */}
                            <div className="flex flex-col gap-2">
                                <button
                                    onClick={() => setShowCardsModal(true)}
                                    disabled={!cards.length}
                                    className="flex items-center justify-center gap-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium py-2 px-3 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    <Eye size={14} />
                                    <span>View Cards</span>
                                </button>
                                <button
                                    onClick={() => {
                                        setRawDataPage(0);
                                        sendMessage('get_raw_data', { guid: company.guid, limit: RAW_PAGE_SIZE, offset: 0 });
                                        setShowJsonModal(true);
                                    }}
                                    disabled={!stats?.totalVouchers}
                                    className="flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium py-2 px-3 rounded-lg transition-colors disabled:opacity-50"
                                >
                                    <FileJson size={14} />
                                    <span>View JSON</span>
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Record Counts */}
                    <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                        <div className="grid grid-cols-3 md:grid-cols-4 gap-4">
                            <div>
                                <div className="text-xl font-bold text-gray-900">{stats.totalVouchers.toLocaleString()}</div>
                                <div className="text-xs text-gray-500">Vouchers</div>
                            </div>
                            <div>
                                <div className="text-xl font-bold text-gray-900">{stats.totalLedgerEntries.toLocaleString()}</div>
                                <div className="text-xs text-gray-500">Ledger Entries</div>
                            </div>
                            <div>
                                <div className="text-xl font-bold text-gray-900">{stats.totalInventoryEntries.toLocaleString()}</div>
                                <div className="text-xs text-gray-500">Inventory Entries</div>
                            </div>
                            <div className="hidden md:block">
                                <div className="text-xl font-bold text-gray-900">{stats.maxAlterId.toLocaleString()}</div>
                                <div className="text-xs text-gray-500">Max Alter ID</div>
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs text-gray-400">
                            <Database size={12} />
                            <span>{isReady ? 'SQLite OPFS connected' : 'Initializing...'}</span>
                        </div>
                        <button
                            onClick={handleClear}
                            disabled={isBusy}
                            className="flex items-center gap-1 text-xs text-red-500 hover:text-red-700 transition-colors disabled:opacity-50"
                        >
                            <Trash2 size={13} />
                            <span>Clear Cache</span>
                        </button>
                    </div>
                </div>
            )}

            {/* Actions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* Download Card */}
                <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-blue-100 p-2 rounded-lg">
                            <Download size={22} className="text-blue-600" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-gray-900">Download Data</h3>
                            <p className="text-xs text-gray-500">Full sync for a date range</p>
                        </div>
                    </div>
                    <div className="space-y-3 mb-4">
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">From Date</label>
                            <div className="relative">
                                <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} disabled={isBusy}
                                    className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                                />
                            </div>
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">To Date</label>
                            <div className="relative">
                                <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                                <input
                                    type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} disabled={isBusy}
                                    className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
                                />
                            </div>
                        </div>
                    </div>
                    <button onClick={handleDownload} disabled={isBusy || !isReady}
                        className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        <Download size={18} /><span>Download</span>
                    </button>
                </div>

                {/* Update Card */}
                <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
                    <div className="flex items-center gap-3 mb-4">
                        <div className="bg-emerald-100 p-2 rounded-lg">
                            <RefreshCw size={22} className="text-emerald-600" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-gray-900">Update Data</h3>
                            <p className="text-xs text-gray-500">Incremental sync (new records only)</p>
                        </div>
                    </div>
                    <div className="bg-gray-50 rounded-lg p-4 mb-4 text-sm text-gray-600">
                        <p>
                            Fetches only records newer than the last synced <code className="bg-gray-200 px-1 rounded">alterid</code>.
                            Uses the stored date range from the last download.
                        </p>
                        {stats && (
                            <p className="mt-2 text-xs text-gray-400">
                                Current max alterid: <strong>{stats.maxAlterId}</strong>
                            </p>
                        )}
                    </div>
                    <button onClick={handleUpdate} disabled={isBusy || !isReady || !stats?.totalVouchers}
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium py-2.5 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                        <RefreshCw size={18} /><span>Update</span>
                    </button>
                </div>
            </div>

            {/* ─── View Cards Modal ───────────────────────────────── */}
            {showCardsModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowCardsModal(false)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                            <h3 className="text-lg font-semibold text-gray-900">Dashboard Cards ({cardCount})</h3>
                            <button onClick={() => setShowCardsModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
                        </div>
                        <div className="overflow-auto flex-1 p-6">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="text-left text-xs text-gray-500 uppercase border-b border-gray-200">
                                        <th className="pb-2 pr-4">Title</th>
                                        <th className="pb-2 pr-4">Chart Type</th>
                                        <th className="pb-2 pr-4">Group By</th>
                                        <th className="pb-2 pr-4">Value</th>
                                        <th className="pb-2">Top N</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {cards.filter(c => c.title !== '__DASHBOARD_SETTINGS__').map(card => (
                                        <tr key={card.id} className="border-b border-gray-100 hover:bg-gray-50">
                                            <td className="py-2.5 pr-4 font-medium text-gray-800">{card.title}</td>
                                            <td className="py-2.5 pr-4">
                                                <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${card.chartType === 'multiAxis' ? 'bg-purple-100 text-purple-700' :
                                                    card.chartType === 'bar' ? 'bg-blue-100 text-blue-700' :
                                                        card.chartType === 'pie' ? 'bg-amber-100 text-amber-700' :
                                                            card.chartType === 'line' ? 'bg-green-100 text-green-700' :
                                                                'bg-gray-100 text-gray-700'
                                                    }`}>
                                                    {card.chartType}
                                                </span>
                                            </td>
                                            <td className="py-2.5 pr-4 text-gray-600">{card.groupBy}</td>
                                            <td className="py-2.5 pr-4 text-gray-600">{card.valueField}</td>
                                            <td className="py-2.5 text-gray-600">{card.topN || '—'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {/* ─── View JSON Modal ────────────────────────────────── */}
            {showJsonModal && (
                <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={() => setShowJsonModal(false)}>
                    <div className="bg-white rounded-xl shadow-2xl max-w-5xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
                            <div>
                                <h3 className="text-lg font-semibold text-gray-900">Sales Data (Raw Vouchers)</h3>
                                {rawData && (
                                    <p className="text-xs text-gray-500 mt-0.5">
                                        Showing {rawData.showing.offset + 1}–{rawData.showing.offset + rawData.showing.count} of {rawData.totalVouchers.toLocaleString()} vouchers
                                    </p>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => {
                                        navigator.clipboard.writeText(JSON.stringify(rawData, null, 2));
                                        setToast('JSON copied to clipboard');
                                        setTimeout(() => setToast(null), 3000);
                                    }}
                                    disabled={!rawData}
                                    className="text-xs bg-blue-100 text-blue-600 px-3 py-1.5 rounded-lg hover:bg-blue-200 transition-colors disabled:opacity-50"
                                >
                                    Copy Page
                                </button>
                                <button onClick={() => setShowJsonModal(false)} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
                            </div>
                        </div>
                        <div className="overflow-auto flex-1 p-4">
                            {!rawData ? (
                                <div className="flex items-center justify-center py-12 text-gray-400">
                                    <Loader2 size={24} className="animate-spin mr-2" /> Loading voucher data...
                                </div>
                            ) : (
                                <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap bg-gray-50 p-4 rounded-lg">
                                    {JSON.stringify(rawData.vouchers, null, 2)}
                                </pre>
                            )}
                        </div>
                        {rawData && (
                            <div className="flex items-center justify-between px-6 py-3 border-t border-gray-200 bg-gray-50">
                                <button
                                    onClick={() => {
                                        const newPage = rawDataPage - 1;
                                        setRawDataPage(newPage);
                                        sendMessage('get_raw_data', { guid: company.guid, limit: RAW_PAGE_SIZE, offset: newPage * RAW_PAGE_SIZE });
                                    }}
                                    disabled={rawDataPage === 0}
                                    className="text-sm px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    ← Previous
                                </button>
                                <span className="text-xs text-gray-500">
                                    Page {rawDataPage + 1} of {Math.ceil(rawData.totalVouchers / RAW_PAGE_SIZE)}
                                </span>
                                <button
                                    onClick={() => {
                                        const newPage = rawDataPage + 1;
                                        setRawDataPage(newPage);
                                        sendMessage('get_raw_data', { guid: company.guid, limit: RAW_PAGE_SIZE, offset: newPage * RAW_PAGE_SIZE });
                                    }}
                                    disabled={(rawDataPage + 1) * RAW_PAGE_SIZE >= rawData.totalVouchers}
                                    className="text-sm px-3 py-1.5 bg-gray-200 rounded-lg hover:bg-gray-300 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    Next →
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default CacheManagement;
