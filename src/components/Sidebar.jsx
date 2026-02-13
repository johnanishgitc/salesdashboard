import React from 'react';
import { NavLink } from 'react-router-dom';
import { LayoutDashboard, Database, LogOut, ArrowLeft } from 'lucide-react';
import clsx from 'clsx';

const Sidebar = () => {
    const navItems = [
        { name: 'Sales Dashboard', path: '/dashboard/sales', icon: LayoutDashboard },
        { name: 'Cache Management', path: '/dashboard/cache', icon: Database },
    ];

    return (
        <div className="w-64 h-full bg-slate-900 text-white flex flex-col">
            <div className="p-6 border-b border-slate-800">
                <h1 className="text-xl font-bold text-blue-400">SalesDash</h1>
            </div>
            <nav className="flex-1 p-4 space-y-2">
                {navItems.map((item) => (
                    <NavLink
                        key={item.path}
                        to={item.path}
                        className={({ isActive }) =>
                            clsx(
                                'flex items-center gap-3 px-4 py-3 rounded-lg transition-colors',
                                isActive
                                    ? 'bg-blue-600 text-white'
                                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                            )
                        }
                    >
                        <item.icon size={20} />
                        <span>{item.name}</span>
                    </NavLink>
                ))}
            </nav>
            <div className="p-4 border-t border-slate-800 space-y-1">
                <NavLink to="/companies" className="flex items-center gap-3 px-4 py-2 rounded-lg text-slate-400 hover:bg-slate-800 hover:text-white transition-colors text-sm">
                    <ArrowLeft size={18} />
                    <span>Select Company</span>
                </NavLink>
                <button onClick={() => {
                    localStorage.removeItem('token');
                    window.location.href = '/login';
                }} className="flex w-full items-center gap-3 px-4 py-2 rounded-lg text-red-400 hover:bg-slate-800 hover:text-red-300 transition-colors text-sm">
                    <LogOut size={18} />
                    <span>Logout</span>
                </button>
            </div>
            <div className="p-4 pt-0">
                <div className="text-xs text-slate-500 text-center">© 2025 IT Catalyst</div>
            </div>
        </div>
    );
};

export default Sidebar;
