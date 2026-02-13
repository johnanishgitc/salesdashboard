import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import { Building2, ChevronRight, LogOut } from 'lucide-react';

const CompanyList = () => {
    const [companies, setCompanies] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const navigate = useNavigate();

    useEffect(() => {
        const fetchCompanies = async () => {
            try {
                const response = await api.get('api/tally/user-connections');
                // Combine createdByMe and sharedWithMe or just use one? 
                // Based on JSON, it has createdByMe and sharedWithMe arrays.
                // Let's combine them for display or just show createdByMe if that's the main interest.
                // User asked for "next page will be list of companies". I'll combine both.

                let allCompanies = [];
                if (response.data.createdByMe) allCompanies = [...allCompanies, ...response.data.createdByMe];
                if (response.data.sharedWithMe) allCompanies = [...allCompanies, ...response.data.sharedWithMe];

                setCompanies(allCompanies);
            } catch (err) {
                console.error('Error fetching companies:', err);
                setError('Failed to load companies. Please try again.');
                // If 401, redirect to login might be handled by interceptor later, but for now:
                if (err.response && err.response.status === 401) {
                    navigate('/login');
                }
            } finally {
                setLoading(false);
            }
        };

        fetchCompanies();
    }, [navigate]);

    const handleSelectCompany = (company) => {
        // Store selected company details if needed, e.g., in localStorage or context
        localStorage.setItem('selectedCompany', JSON.stringify(company));
        navigate('/dashboard/sales'); // Default to sales dashboard
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('selectedCompany');
        navigate('/login');
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gray-50">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-50 p-8">
            <div className="max-w-5xl mx-auto">
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-3xl font-bold text-gray-900">Select Company</h1>
                        <p className="mt-2 text-gray-600">Choose a company to view dashboard</p>
                    </div>
                    <button
                        onClick={handleLogout}
                        className="flex items-center gap-2 px-4 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                    >
                        <LogOut size={20} />
                        <span>Logout</span>
                    </button>
                </div>

                {error && (
                    <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded relative mb-6" role="alert">
                        <span className="block sm:inline">{error}</span>
                    </div>
                )}

                <div className="grid gap-4">
                    {companies.length === 0 ? (
                        <div className="text-center py-12 bg-white rounded-xl border border-gray-200 shadow-sm">
                            <Building2 className="mx-auto h-12 w-12 text-gray-400" />
                            <h3 className="mt-2 text-lg font-medium text-gray-900">No companies found</h3>
                            <p className="mt-1 text-sm text-gray-500">You don't have access to any companies yet.</p>
                        </div>
                    ) : (
                        <div className="bg-white shadow overflow-hidden sm:rounded-md">
                            <ul className="divide-y divide-gray-200">
                                {companies.map((company, index) => (
                                    <li key={company.guid || index}>
                                        <button
                                            onClick={() => handleSelectCompany(company)}
                                            className="block w-full hover:bg-gray-50 transition duration-150 ease-in-out text-left"
                                        >
                                            <div className="px-6 py-5 flex items-center justify-between">
                                                <div className="flex items-center min-w-0">
                                                    <div className="flex-shrink-0 bg-blue-100 rounded-full p-3">
                                                        <Building2 className="h-6 w-6 text-blue-600" />
                                                    </div>
                                                    <div className="ml-4 truncate">
                                                        <div className="text-lg font-medium text-blue-600 truncate">{company.company || 'Unknown Company'}</div>
                                                        <div className="mt-1 flex flex-col sm:flex-row sm:gap-6 text-sm text-gray-500">
                                                            <span>Conn Name: <span className="text-gray-900">{company.conn_name}</span></span>
                                                            <span>ID: <span className="text-gray-900">{company.tallyloc_id}</span></span>
                                                            <span className="truncate">GUID: <span className="text-gray-900">{company.guid}</span></span>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="ml-4 flex-shrink-0">
                                                    <ChevronRight className="h-5 w-5 text-gray-400" />
                                                </div>
                                            </div>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default CompanyList;
