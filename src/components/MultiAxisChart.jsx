import React from 'react';
import {
    ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer
} from 'recharts';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

/**
 * MultiAxisChart – renders a Recharts ComposedChart with dual Y-axes.
 *
 * Props:
 *   title      - Card title
 *   data       - Array of { name, [seriesAlias]: value, ... }
 *   seriesInfo - Array of { id, label, alias, axis:'left'|'right', type:'bar'|'line', field }
 *   height     - Chart height (default 300)
 */
const MultiAxisChart = React.memo(({ title, data = [], seriesInfo = [], height = 300 }) => {
    if (!data || data.length === 0) {
        return (
            <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex flex-col items-center justify-center" style={{ height: height + 60 }}>
                <h3 className="text-base font-semibold text-gray-800 mb-4">{title}</h3>
                <p className="text-gray-400 text-sm">No data available</p>
            </div>
        );
    }

    const hasRight = seriesInfo.some(s => s.axis === 'right');

    const formatValue = (val) => {
        if (typeof val !== 'number') return val;
        if (Math.abs(val) >= 1e7) return `${(val / 1e7).toFixed(1)}Cr`;
        if (Math.abs(val) >= 1e5) return `${(val / 1e5).toFixed(1)}L`;
        if (Math.abs(val) >= 1e3) return `${(val / 1e3).toFixed(0)}k`;
        return val.toFixed(0);
    };

    return (
        <div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm flex flex-col" style={{ height: height + 60 }}>
            <h3 className="text-base font-semibold text-gray-800 mb-4 truncate" title={title}>{title}</h3>
            <div className="flex-1 min-h-0">
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: data.length > 3 ? 60 : 5 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f0f0f0" />
                        <XAxis
                            dataKey="name"
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
                            yAxisId="left"
                            tick={{ fontSize: 11 }}
                            axisLine={false}
                            tickLine={false}
                            tickFormatter={formatValue}
                            width={50}
                        />
                        {hasRight && (
                            <YAxis
                                yAxisId="right"
                                orientation="right"
                                tick={{ fontSize: 11 }}
                                axisLine={false}
                                tickLine={false}
                                tickFormatter={formatValue}
                                width={50}
                            />
                        )}
                        <Tooltip
                            formatter={(val, name) => [typeof val === 'number' ? val.toLocaleString('en-IN') : val, name]}
                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                        />
                        <Legend />
                        {seriesInfo.map((s, idx) => {
                            const color = COLORS[idx % COLORS.length];
                            const yAxis = s.axis || 'left';
                            if (s.type === 'line') {
                                return (
                                    <Line
                                        key={s.id || idx}
                                        yAxisId={yAxis}
                                        type="monotone"
                                        dataKey={s.alias || s.id}
                                        name={s.label || s.field}
                                        stroke={color}
                                        strokeWidth={2}
                                        dot={{ r: 3 }}
                                        activeDot={{ r: 6 }}
                                    />
                                );
                            }
                            return (
                                <Bar
                                    key={s.id || idx}
                                    yAxisId={yAxis}
                                    dataKey={s.alias || s.id}
                                    name={s.label || s.field}
                                    fill={color}
                                    radius={[4, 4, 0, 0]}
                                    barSize={20}
                                />
                            );
                        })}
                    </ComposedChart>
                </ResponsiveContainer>
            </div>
        </div>
    );
});

MultiAxisChart.displayName = 'MultiAxisChart';

export default MultiAxisChart;
