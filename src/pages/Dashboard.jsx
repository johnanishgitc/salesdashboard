import React, { useEffect, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import useWorker from '../hooks/useWorker';
import {
    AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import {
    DollarSign, ShoppingCart, TrendingUp, CreditCard, Loader2, Calendar, AlertCircle, RefreshCw
} from 'lucide-react';

const ChartWidget = lazy(() => import('../components/ChartWidget'));
const MultiAxisChart = lazy(() => import('../components/MultiAxisChart'));

// ─── Cached Formatters (avoid recreating on every call) ─────────────

const currencyFmt = new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
});
const formatCurrency = (value) => currencyFmt.format(value || 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const formatPeriod = (p) => {
    if (!p || p.length < 6) return p;
    return `${MONTHS[parseInt(p.substring(4, 6), 10) - 1]} ${p.substring(0, 4)}`;
};

// ─── Chart Loading Fallback ─────────────────────────────────────────

const ChartFallback = () => (
    <div className="flex items-center justify-center h-80 text-gray-400">
        <Loader2 size={20} className="animate-spin mr-2" /> Loading chart...
    </div>
);

// ─── KPI Card (memoized) ────────────────────────────────────────────

const KpiCard = React.memo(({ title, value, icon, color }) => (
    <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex items-center justify-between">
        <div>
            <p className="text-sm font-medium text-gray-500 mb-1">{title}</p>
            <h3 className="text-2xl font-bold text-gray-900">{value}</h3>
        </div>
        <div className={`p-3 rounded-lg ${color} shadow-md`}>{icon}</div>
    </div>
));
KpiCard.displayName = 'KpiCard';

// ─── Dashboard ──────────────────────────────────────────────────────

const Dashboard = () => {
    const { isReady, dashboardData, customCardsData, error, sendMessage } = useWorker();
    const [company, setCompany] = useState({});
    const [fromDate, setFromDate] = useState('2025-04-01');
    const [toDate, setToDate] = useState(new Date().toISOString().split('T')[0]);
    
    // Debounced date state for fetching data (primitives to avoid object ref issues)
    const [appliedFromDate, setAppliedFromDate] = useState('2025-04-01');
    const [appliedToDate, setAppliedToDate] = useState(new Date().toISOString().split('T')[0]);

    // Debounce effect
    useEffect(() => {
        const timer = setTimeout(() => {
            setAppliedFromDate(fromDate);
            setAppliedToDate(toDate);
        }, 400);
        return () => clearTimeout(timer);
    }, [fromDate, toDate]);

    // Optimize: Update immediately on blur or Enter key
    const handleDateBlur = () => {
        setAppliedFromDate(fromDate);
        setAppliedToDate(toDate);
    };

    const handleDateKeyDown = (e) => {
        if (e.key === 'Enter') {
            setAppliedFromDate(fromDate);
            setAppliedToDate(toDate);
        }
    };



    const applyPreset = (type) => {
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = now.getMonth(); // 0-11
        const dd = String(now.getDate()).padStart(2, '0');
        
        let startStr = '';
        const endStr = now.toISOString().split('T')[0];

        if (type === 'MTD') {
            startStr = `${yyyy}-${String(mm + 1).padStart(2, '0')}-01`;
        } else if (type === 'QTD') {
            // Q1: Apr-Jun (3,4,5), Q2: Jul-Sep (6,7,8), Q3: Oct-Dec (9,10,11), Q4: Jan-Mar (0,1,2)
            if (mm >= 3 && mm <= 5) startStr = `${yyyy}-04-01`;
            else if (mm >= 6 && mm <= 8) startStr = `${yyyy}-07-01`;
            else if (mm >= 9 && mm <= 11) startStr = `${yyyy}-10-01`;
            else startStr = `${yyyy}-01-01`;
        } else if (type === 'FYTD') {
            // If Jan-Mar, FY started Prev Year Apr
            if (mm < 3) startStr = `${yyyy - 1}-04-01`;
            else startStr = `${yyyy}-04-01`;
        }

        setFromDate(startStr);
        setToDate(endStr);
        setAppliedFromDate(startStr);
        setAppliedToDate(endStr);
    };

    const [apiCards, setApiCards] = useState([]);
    const [cardSettings, setCardSettings] = useState({});
    const [cardsLoading, setCardsLoading] = useState(true);

    // State for multiple filters: { [dimension]: { value, label, dimensionLabel } }
    const [activeFilters, setActiveFilters] = useState({});

    // Load company from localStorage
    useEffect(() => {
        const stored = JSON.parse(localStorage.getItem('selectedCompany') || '{}');
        setCompany(stored);
    }, []);

    // Fetch card configurations from API
    useEffect(() => {
        const fetchCards = async () => {
            if (!company.guid) return;
            try {
                const token = localStorage.getItem('token');
                const tallylocId = company.tallyloc_id || company.tallyLocId || '';
                const url = `/api/dashboard/cards?dashboardType=sales&tallylocId=${tallylocId}&coGuid=${company.guid}&isActive=true`;
                const res = await fetch(url, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                const json = await res.json();
                if (json.status === 'success' && json.data) {
                    const settings = json.data.find(c => c.title === '__DASHBOARD_SETTINGS__');
                    if (settings?.cardConfig) setCardSettings(settings.cardConfig);
                    const cards = json.data.filter(c => c.title !== '__DASHBOARD_SETTINGS__' && c.isActive);
                    setApiCards(cards);
                }
            } catch (err) {
                console.warn('[Dashboard] Could not fetch card configs:', err);
            } finally {
                setCardsLoading(false);
            }
        };
        fetchCards();
    }, [company.guid]);

    // Request KPI + core + extended dashboard data
    useEffect(() => {
        if (isReady && company.guid) {
            const filters = {};
            Object.values(activeFilters).forEach(f => {
                filters[f.dimension] = f.value;
            });
            sendMessage('get_dashboard_data', {
                guid: company.guid,
                fromDate: appliedFromDate.replace(/-/g, ''),
                toDate: appliedToDate.replace(/-/g, ''),
                filters
            });
            // Fetch extended data separately (async) to unblock UI
            sendMessage('get_extended_dashboard_data', {
                guid: company.guid,
                fromDate: appliedFromDate.replace(/-/g, ''),
                toDate: appliedToDate.replace(/-/g, ''),
                filters
            });
        }
    }, [isReady, company.guid, sendMessage, appliedFromDate, appliedToDate, activeFilters]);

    // Request custom card data from worker once API cards are loaded
    useEffect(() => {
        if (isReady && company.guid && apiCards.length > 0) {
            const cardsWithDates = apiCards.map(card => {
                const periodSettings = cardSettings.cardPeriodSettings?.[card.title];
                let cardFrom = appliedFromDate.replace(/-/g, '');
                let cardTo = appliedToDate.replace(/-/g, '');
                if (card.cardConfig?.overrideDateFilter && periodSettings) {
                    cardFrom = periodSettings.fromDate.replace(/-/g, '');
                    cardTo = periodSettings.toDate.replace(/-/g, '');
                }
                return { ...card, _fromDate: cardFrom, _toDate: cardTo };
            });

            const filters = {};
            Object.values(activeFilters).forEach(f => {
                filters[f.dimension] = f.value;
            });

            sendMessage('get_custom_cards_data', {
                guid: company.guid,
                fromDate: appliedFromDate.replace(/-/g, ''),
                toDate: appliedToDate.replace(/-/g, ''),
                cards: cardsWithDates,
                filters
            });
        }
    }, [isReady, company.guid, apiCards, sendMessage, appliedFromDate, appliedToDate, cardSettings, activeFilters]);

    const handleRefresh = useCallback(() => {
        if (isReady && company.guid) {
            const filters = {};
            Object.values(activeFilters).forEach(f => {
                filters[f.dimension] = f.value;
            });
            sendMessage('get_dashboard_data', {
                guid: company.guid,
                fromDate: fromDate.replace(/-/g, ''),
                toDate: toDate.replace(/-/g, ''),
                filters
            });
            sendMessage('get_extended_dashboard_data', {
                guid: company.guid,
                fromDate: fromDate.replace(/-/g, ''),
                toDate: toDate.replace(/-/g, ''),
                filters
            });

            if (apiCards.length > 0) {
                sendMessage('get_custom_cards_data', {
                    guid: company.guid,
                    fromDate: fromDate.replace(/-/g, ''),
                    toDate: toDate.replace(/-/g, ''),
                    cards: apiCards,
                    filters
                });
            }
        }
    }, [isReady, company.guid, sendMessage, fromDate, toDate, apiCards, activeFilters]);

    // Sort API cards by cardSortIndex
    const sortedCards = useMemo(() => {
        const sortIndex = cardSettings.cardSortIndex || {};
        return [...apiCards].sort((a, b) => {
            const aIdx = sortIndex[a.title] ?? 999;
            const bIdx = sortIndex[b.title] ?? 999;
            return aIdx - bIdx;
        });
    }, [apiCards, cardSettings]);

    // ─── Error State ────────────────────────────────────────────────────
    if (error) {
        return (
            <div className="flex flex-col items-center justify-center p-12 text-red-500 bg-red-50 rounded-lg border border-red-200 m-6">
                <AlertCircle size={48} className="mb-4" />
                <h3 className="text-lg font-bold">Error Loading Dashboard</h3>
                <p className="text-sm mt-2">{error}</p>
                <button onClick={handleRefresh} className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 flex items-center gap-2">
                    <RefreshCw size={16} /> Retry
                </button>
            </div>
        );
    }

    // ─── Loading State ──────────────────────────────────────────────────
    if (!dashboardData) {
        return (
            <div className="flex flex-col items-center justify-center h-screen text-gray-500 bg-gray-50">
                <Loader2 size={48} className="animate-spin mb-4 text-blue-600" />
                <p className="font-medium">Loading dashboard...</p>
                <p className="text-xs mt-2 text-gray-400">Fetching from local database</p>
            </div>
        );
    }

    const { kpi, charts, extended } = dashboardData;
    const ext = extended || {};

    // ─── Render ─────────────────────────────────────────────────────────

    return (
        <div className="space-y-6 pb-12">
            {/* Header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-4 bg-white p-4 rounded-xl shadow-sm border border-gray-200">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900">Sales Dashboard</h1>
                    <p className="text-gray-500 text-sm mt-1">
                        Analyzing <span className="font-semibold text-blue-600">{company.company}</span>
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-1 mr-2">
                        <button onClick={() => applyPreset('MTD')} className="px-3 py-1.5 text-xs font-semibold bg-white border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600 shadow-sm transition-colors">MTD</button>
                        <button onClick={() => applyPreset('QTD')} className="px-3 py-1.5 text-xs font-semibold bg-white border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600 shadow-sm transition-colors">QTD</button>
                        <button onClick={() => applyPreset('FYTD')} className="px-3 py-1.5 text-xs font-semibold bg-white border border-gray-200 rounded-md hover:bg-gray-50 text-gray-600 shadow-sm transition-colors">FYTD</button>
                    </div>
                    <div className="flex items-center gap-2 bg-gray-50 p-2 rounded-lg border border-gray-200">
                        <Calendar size={16} className="text-gray-400" />
                        <input
                            type="date"
                            value={fromDate}
                            onChange={(e) => setFromDate(e.target.value)}
                            onBlur={handleDateBlur}
                            onKeyDown={handleDateKeyDown}
                            className="text-sm bg-transparent border-none focus:ring-0 text-gray-700 p-0"
                        />
                        <span className="text-gray-400">-</span>
                        <input
                            type="date"
                            value={toDate}
                            onChange={(e) => setToDate(e.target.value)}
                            onBlur={handleDateBlur}
                            onKeyDown={handleDateKeyDown}
                            className="text-sm bg-transparent border-none focus:ring-0 text-gray-700 p-0"
                        />
                    </div>
                    <button onClick={handleRefresh} className="p-2 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 transition-colors" title="Reload"><RefreshCw size={18} /></button>
                </div>
            </div>

            {/* Active Filter Pill */}
            {/* Active Filter Pills */}
            {Object.keys(activeFilters).length > 0 && (
                <div className="flex flex-wrap items-center gap-2">
                    {Object.values(activeFilters).map((filter) => (
                        <div key={filter.dimension} className="bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm font-medium flex items-center gap-2 border border-blue-200 shadow-sm animate-in fade-in zoom-in duration-200">
                            <span>{filter.dimensionLabel}: <b>{filter.label}</b></span>
                            <button
                                onClick={() => {
                                    const next = { ...activeFilters };
                                    delete next[filter.dimension];
                                    setActiveFilters(next);
                                }}
                                className="hover:bg-blue-200 p-0.5 rounded-full transition-colors"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                            </button>
                        </div>
                    ))}
                    {Object.keys(activeFilters).length > 1 && (
                        <button
                            onClick={() => setActiveFilters({})}
                            className="text-xs text-gray-500 hover:text-red-500 underline"
                        >
                            Clear All
                        </button>
                    )}
                </div>
            )}

            {/* KPI Cards */}
            <KpiCards kpi={kpi} />

            {/* Hero Chart: Sales Trend */}
            <SalesTrendChart data={charts.salesTrend} />

            {/* ─── Built-in Charts Grid ─────────────────────────────────── */}
            <BuiltInCharts ext={ext} charts={charts} activeFilters={activeFilters} onFilterChange={setActiveFilters} isLoading={!extended} />

            {/* ─── Dynamic API Cards ────────────────────────────────────── */}
            {apiCards.length > 0 && (
                <>
                    <div className="flex items-center gap-3 mt-4">
                        <div className="h-px flex-1 bg-gray-200" />
                        <span className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Custom Cards</span>
                        <div className="h-px flex-1 bg-gray-200" />
                    </div>
                    {cardsLoading ? (
                        <div className="flex items-center justify-center p-8 text-gray-400">
                            <Loader2 size={24} className="animate-spin mr-2" /> Loading custom cards...
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                            {sortedCards.map(card => (
                                <DynamicCard key={card.id} card={card} customCardsData={customCardsData} />
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
};

// ─── Extracted Sub-Components (avoid recomputing on unrelated state changes) ──

const KpiCards = React.memo(({ kpi }) => (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard title="Total Revenue" value={formatCurrency(kpi.totalSales)} icon={<DollarSign size={24} className="text-white" />} color="bg-blue-600" />
        <KpiCard title="Total Transactions" value={(kpi.totalTxns || 0).toLocaleString()} icon={<ShoppingCart size={24} className="text-white" />} color="bg-emerald-500" />
        <KpiCard title="Avg. Order Value" value={formatCurrency(kpi.avgOrderValue)} icon={<TrendingUp size={24} className="text-white" />} color="bg-purple-500" />
        <KpiCard title="Max Single Sale" value={formatCurrency(kpi.maxSale)} icon={<CreditCard size={24} className="text-white" />} color="bg-orange-500" />
    </div>
));
KpiCards.displayName = 'KpiCards';

const SalesTrendChart = React.memo(({ data }) => (
    <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
        <h3 className="text-lg font-semibold text-gray-800 mb-4">Daily Sales Trend</h3>
        <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data}>
                    <defs>
                        <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#2563eb" stopOpacity={0.1} />
                            <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                    <XAxis dataKey="date" tickFormatter={(s) => s ? `${s.substring(6, 8)}/${s.substring(4, 6)}` : ''} tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} width={50} />
                    <Tooltip formatter={(v) => formatCurrency(v)} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                    <Area type="monotone" dataKey="total" name="Sales" stroke="#2563eb" strokeWidth={2} fillOpacity={1} fill="url(#colorSales)" />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    </div>
));
SalesTrendChart.displayName = 'SalesTrendChart';

const BuiltInCharts = React.memo(({ ext, charts, activeFilters, onFilterChange, isLoading }) => {
    const monthlySales = useMemo(() =>
        (ext.salesByPeriod || []).map(d => ({ name: formatPeriod(d.period), value: d.value, period: d.period })), [ext.salesByPeriod]);

    const profitTrend = useMemo(() =>
        (ext.monthWiseProfit || []).map(d => ({ name: formatPeriod(d.period), value: d.value, period: d.period })), [ext.monthWiseProfit]);

    const revenueVsProfitData = useMemo(() =>
        (ext.salesByPeriod || []).map(sp => {
            const profitRow = (ext.monthWiseProfit || []).find(mp => mp.period === sp.period);
            return { name: formatPeriod(sp.period), revenue: sp.value, profit: profitRow?.value || 0, period: sp.period };
        }), [ext.salesByPeriod, ext.monthWiseProfit]);

    const revProfitKeys = useMemo(() => [
        { key: 'revenue', color: '#3b82f6', name: 'Revenue' },
        { key: 'profit', color: '#10b981', name: 'Profit' },
    ], []);

    const handleBarClick = useCallback((val, chartTitle) => {
        let dimension = '';
        let dimensionLabel = '';
        let value = val;

        switch (chartTitle) {
            case 'Sales by Stock Group': dimension = 'stockGroup'; dimensionLabel = 'Stock Group'; break;
            case 'Sales by Ledger Group': dimension = 'ledgerGroup'; dimensionLabel = 'Ledger Group'; break;
            case 'Sales by Region / State': dimension = 'state'; dimensionLabel = 'State'; break;
            case 'Sales by Country': dimension = 'country'; dimensionLabel = 'Country'; break;
            case 'Top Customers': dimension = 'customer'; dimensionLabel = 'Customer'; break;
            case 'Top Items (Revenue)':
            case 'Top Items (Quantity)':
            case 'Most Profitable Items':
            case 'Least Profitable Items':
                dimension = 'stockItem'; dimensionLabel = 'Item'; break;
            case 'Monthly Sales':
            case 'Profit Trend (Monthly)':
            case 'Revenue vs Profit':
                dimension = 'period'; dimensionLabel = 'Period';
                // val is "Apr 2025" (name). We need "202504" (period).
                // We kept 'period' in the data objects above. 
                // ChartWidget passes back entry.name or entry.period?
                // ChartWidget handleClick calls onBarClick(entry.name || entry.period).
                // So if name is present, it passes name.
                // We need to lookup the period code if we only got the formatted name.
                // Ideally ChartWidget shouldn't decide. It passes the whole entry or let us find it.
                // Let's assume for Month charts we pass the raw period value if possible, or reverse lookup.
                // Simpler: The data object has `period`. 
                // REVISIT ChartWidget: `onBarClick(entry.name || entry.period)`.
                // If entry has name "Apr 2025", it returns "Apr 2025".
                // We need to convert back. 
                // Let's do a quick lookup if needed.
                if (val.includes(' ')) { // "Apr 2025"
                    const parts = val.split(' ');
                    const monthIdx = MONTHS.indexOf(parts[0]) + 1;
                    if (monthIdx > 0) {
                        value = `${parts[1]}${monthIdx.toString().padStart(2, '0')}`;
                    }
                }
                break;
            case 'Salesperson Totals': dimension = 'salesperson'; dimensionLabel = 'Salesperson'; break;
            default: return;
        }



        onFilterChange(prev => {
            const next = { ...prev };
            // If clicking the same value on a dimension, toggle it off
            // If clicking a different value on same dimension, switch to it (standard drilldown behavior)
            if (next[dimension] && next[dimension].value === value) {
                delete next[dimension];
            } else {
                next[dimension] = { dimension, value, label: val, dimensionLabel };
            }
            return next;
        });
    }, [onFilterChange]);

    const getActiveLabel = (chartTitle) => {
        // Return the label if the active filter corresponds to this chart
        // This highlights the bar.
        // Map chart title to dimension
        let dim = '';
        switch (chartTitle) {
            case 'Sales by Stock Group': dim = 'stockGroup'; break;
            case 'Sales by Ledger Group': dim = 'ledgerGroup'; break;
            case 'Sales by Region / State': dim = 'state'; break;
            case 'Sales by Country': dim = 'country'; break;
            case 'Top Customers': dim = 'customer'; break;
            case 'Top Items (Revenue)':
            case 'Top Items (Quantity)':
            case 'Most Profitable Items':
            case 'Least Profitable Items':
            case 'Top Profitable Items':
            case 'Top Loss Items':
                dim = 'stockItem'; break;
            case 'Monthly Sales':
            case 'Profit Trend (Monthly)':
            case 'Revenue vs Profit':
                dim = 'period'; break;
            case 'Salesperson Totals': dim = 'salesperson'; break;
        }
        return activeFilters[dim] ? activeFilters[dim].label : null;
    };

    return (
        <Suspense fallback={<ChartFallback />}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <ChartWidget title="Sales by Stock Group" data={ext.salesByStockGroup || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Sales by Stock Group')} activeFilterLabel={getActiveLabel('Sales by Stock Group')} loading={isLoading} />
                <ChartWidget title="Sales by Ledger Group" data={ext.salesByLedgerGroup || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Sales by Ledger Group')} activeFilterLabel={getActiveLabel('Sales by Ledger Group')} loading={isLoading} />
                <ChartWidget title="Sales by Region / State" data={charts.salesByState || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Sales by Region / State')} activeFilterLabel={getActiveLabel('Sales by Region / State')} />
                <ChartWidget title="Sales by Country" data={ext.salesByCountry || []} defaultType="pie" onBarClick={(v) => handleBarClick(v, 'Sales by Country')} activeFilterLabel={getActiveLabel('Sales by Country')} loading={isLoading} />
                <ChartWidget title="Monthly Sales" data={monthlySales} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Monthly Sales')} activeFilterLabel={getActiveLabel('Monthly Sales')} loading={isLoading} />
                <ChartWidget title="Profit Trend (Monthly)" data={profitTrend} defaultType="line" onBarClick={(v) => handleBarClick(v, 'Profit Trend (Monthly)')} activeFilterLabel={getActiveLabel('Profit Trend (Monthly)')} loading={isLoading} />
                <ChartWidget title="Revenue vs Profit" data={revenueVsProfitData} dataKeys={revProfitKeys} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Revenue vs Profit')} activeFilterLabel={getActiveLabel('Revenue vs Profit')} loading={isLoading} />
                <ChartWidget title="Top Customers" data={charts.topCustomers || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Top Customers')} activeFilterLabel={getActiveLabel('Top Customers')} />
                <ChartWidget title="Top Items (Revenue)" data={charts.topItems || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Top Items (Revenue)')} activeFilterLabel={getActiveLabel('Top Items (Revenue)')} />
                <ChartWidget title="Top Items (Quantity)" data={ext.topItemsByQty || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Top Items (Quantity)')} activeFilterLabel={getActiveLabel('Top Items (Quantity)')} loading={isLoading} />
                <ChartWidget title="Salesperson Totals" data={ext.salesBySalesperson || []} defaultType="treemap" onBarClick={(v) => handleBarClick(v, 'Salesperson Totals')} activeFilterLabel={getActiveLabel('Salesperson Totals')} loading={isLoading} />
                <ChartWidget title="Top Profitable Items" data={ext.topProfitableItems || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Most Profitable Items')} activeFilterLabel={getActiveLabel('Most Profitable Items')} loading={isLoading} />
                <ChartWidget title="Top Loss Items" data={ext.topLossItems || []} defaultType="bar" onBarClick={(v) => handleBarClick(v, 'Least Profitable Items')} activeFilterLabel={getActiveLabel('Least Profitable Items')} loading={isLoading} />
            </div>
        </Suspense>
    );
});
BuiltInCharts.displayName = 'BuiltInCharts';

// ─── Dynamic Card Renderer ──────────────────────────────────────────

const DynamicCard = React.memo(({ card, customCardsData }) => {
    const cardData = customCardsData?.[card.id];
    if (card.chartType === 'multiAxis') {
        if (!cardData || !cardData.isMultiAxis) {
            return <Suspense fallback={null}><MultiAxisChart title={card.title} data={[]} seriesInfo={[]} /></Suspense>;
        }
        return <Suspense fallback={null}><MultiAxisChart title={card.title} data={cardData.data} seriesInfo={cardData.seriesInfo} /></Suspense>;
    }
    if (cardData?.isSegmented) {
        return (
            <Suspense fallback={null}>
                <ChartWidget
                    title={card.title} data={cardData.data} segments={cardData.segments}
                    isSegmented={true} stacked={card.cardConfig?.enableStacking ?? false}
                    defaultType={card.chartType || 'bar'}
                />
            </Suspense>
        );
    }
    const data = Array.isArray(cardData) ? cardData : [];
    return <Suspense fallback={null}><ChartWidget title={card.title} data={data} defaultType={card.chartType || 'bar'} /></Suspense>;
});
DynamicCard.displayName = 'DynamicCard';

export default Dashboard;
