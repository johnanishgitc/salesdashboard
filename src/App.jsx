import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import CompanyList from './pages/CompanyList';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import CacheManagement from './pages/CacheManagement';

import './index.css';

const ProtectedRoute = ({ children }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return children;
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />

        <Route path="/companies" element={
          <ProtectedRoute>
            <CompanyList />
          </ProtectedRoute>
        } />

        <Route path="/dashboard" element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }>
          <Route path="sales" element={<Dashboard />} />
          <Route path="cache" element={<CacheManagement />} />
          <Route index element={<Navigate to="sales" replace />} />
        </Route>

        <Route path="/" element={<Navigate to="/login" replace />} />
      </Routes>
    </Router>
  );
}

export default App;
