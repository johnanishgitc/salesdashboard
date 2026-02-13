import React, { useState, useMemo } from 'react';
import {
    BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
    XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';
import { BarChart2, PieChart as PieIcon, TrendingUp } from 'lucide-react';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658', '#ff6b6b', '#48dbfb', '#ff9ff3'];

// Cached formatter (avoid recreating Intl.NumberFormat on every call)
const stdFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const compactFmt = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0, notation: 'compact' });

const ChartWidget = React.memo(({
    title,
    data = [],
    dataKey = 'value',
    dataKeys = [],
    segments = [],
    nameKey = 'name',
    defaultType = 'bar',
    isSegmented = false,
    stacked = false,
    height = 300,
    colors = COLORS
}) => {
    const [chartType, setChartType] = useState(defaultType);

    const series = useMemo(() =>
        dataKeys.length > 0 ? dataKeys : [{ key: dataKey, color: '#8884d8', name: 'Value' }],
        [dataKeys, dataKey]);

    const formatCurrency = (val) => {
        if (typeof val === 'number') {
            return (Math.abs(val) > 10000000 ? compactFmt : stdFmt).format(val);
        }
        return val;
    };

    const chart = useMemo(() => {
        if (!data || data.length === 0) {
            return (
                <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                    No data available
                </div>
            );
        }

        // Stacked/segmented bar chart
        if (isSegmented && segments.length > 0 && chartType === 'bar') {
            return (
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: data.length > 3 ? 60 : 5 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                        <XAxis
                            dataKey={nameKey}
                            tick={({ x, y, payload }) => (
                                <g transform={`translate(${x},${y})`}>
                                    <text x={0} y={0} dy={16} textAnchor="middle" fill="#6b7280" fontSize={10}
                                        transform={data.length > 3 ? "rotate(-45)" : ""}>
                                        {payload.value && payload.value.length > 10 ? `${payload.value.substring(0, 8)}..` : payload.value}
                                    </text>
                                </g>
                            )}
                            interval={0}
                            height={data.length > 3 ? 80 : 30}
                            tickLine={false}
                            axisLine={{ stroke: '#e5e7eb' }}
                        />
                        <YAxis tickFormatter={val => val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val} tick={{ fontSize: 11, fill: '#6b7280' }} width={40} axisLine={false} tickLine={false} />
                        <Tooltip formatter={(value) => formatCurrency(value)} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} />
                        <Legend wrapperStyle={{ fontSize: 10, paddingTop: '8px' }} />
                        {segments.map((seg, i) => (
                            <Bar key={seg} dataKey={seg} name={seg.length > 15 ? `${seg.substring(0, 13)}..` : seg} stackId={stacked ? 'stack' : undefined} fill={colors[i % colors.length]} radius={stacked ? undefined : [2, 2, 0, 0]} />
                        ))}
                    </BarChart>
                </ResponsiveContainer>
            );
        }

        switch (chartType) {
            case 'pie': {
                const pKey = series[0].key;
                return (
                    <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                            <Pie data={data} cx="50%" cy="50%" innerRadius={60} outerRadius={80} paddingAngle={5} dataKey={pKey} nameKey={nameKey}>
                                {data.map((entry, index) => (
                                    <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                                ))}
                            </Pie>
                            <Tooltip formatter={(value) => formatCurrency(value)} />
                            <Legend />
                        </PieChart>
                    </ResponsiveContainer>
                );
            }
            case 'line':
                return (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={data}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} />
                            <XAxis dataKey={nameKey} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                            <YAxis tickFormatter={val => val > 1000 ? `${(val / 1000).toFixed(0)}k` : val} tick={{ fontSize: 11 }} width={40} axisLine={false} tickLine={false} />
                            <Tooltip formatter={(value) => formatCurrency(value)} />
                            <Legend />
                            {series.map((s, i) => (
                                <Line key={s.key} type="monotone" dataKey={s.key} name={s.name || s.key} stroke={s.color || colors[i % colors.length]} activeDot={{ r: 6 }} />
                            ))}
                        </LineChart>
                    </ResponsiveContainer>
                );
            case 'bar':
            default:
                return (
                    <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: data.length > 3 ? 60 : 5 }}>
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f3f4f6" />
                            <XAxis
                                dataKey={nameKey}
                                tick={({ x, y, payload }) => {
                                    return (
                                        <g transform={`translate(${x},${y})`}>
                                            <text
                                                x={0}
                                                y={0}
                                                dy={16}
                                                textAnchor="middle"
                                                fill="#6b7280"
                                                fontSize={11}
                                                transform={data.length > 3 ? "rotate(-45)" : ""}
                                            >
                                                {payload.value && payload.value.length > 12 ? `${payload.value.substring(0, 10)}...` : payload.value}
                                            </text>
                                        </g>
                                    );
                                }}
                                interval={0}
                                height={data.length > 3 ? 80 : 30}
                                tickLine={false}
                                axisLine={{ stroke: '#e5e7eb' }}
                            />
                            <YAxis
                                tickFormatter={val => val >= 1000 ? `${(val / 1000).toFixed(0)}k` : val}
                                tick={{ fontSize: 11, fill: '#6b7280' }}
                                width={40}
                                axisLine={false}
                                tickLine={false}
                            />
                            <Tooltip
                                formatter={(value) => formatCurrency(value)}
                                cursor={{ fill: '#f3f4f6' }}
                                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                            />
                            <Legend wrapperStyle={{ paddingTop: '10px' }} />
                            {series.map((s, i) => (
                                <Bar key={s.key} dataKey={s.key} name={s.name || s.key} fill={s.color || colors[i % colors.length]} radius={[4, 4, 0, 0]}>
                                    {series.length === 1 && data.map((entry, index) => (
                                        <Cell key={`cell-${index}`} fill={colors[index % colors.length]} />
                                    ))}
                                </Bar>
                            ))}
                        </BarChart>
                    </ResponsiveContainer>
                );
        }
    }, [data, chartType, series, segments, isSegmented, stacked, nameKey, colors]);

    return (
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex flex-col" style={{ height: height + 60 }}>
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-base font-semibold text-gray-800 truncate" title={title}>{title}</h3>
                <div className="flex bg-gray-100 rounded-lg p-0.5 gap-0.5">
                    <button onClick={() => setChartType('bar')} className={`p-1.5 rounded-md transition-colors ${chartType === 'bar' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`} title="Bar Chart"><BarChart2 size={14} /></button>
                    <button onClick={() => setChartType('pie')} className={`p-1.5 rounded-md transition-colors ${chartType === 'pie' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`} title="Pie Chart"><PieIcon size={14} /></button>
                    <button onClick={() => setChartType('line')} className={`p-1.5 rounded-md transition-colors ${chartType === 'line' ? 'bg-white shadow-sm text-blue-600' : 'text-gray-500 hover:text-gray-700'}`} title="Line Chart"><TrendingUp size={14} /></button>
                </div>
            </div>
            <div className="flex-1 min-h-0">{chart}</div>
        </div>
    );
});

ChartWidget.displayName = 'ChartWidget';

export default ChartWidget;
