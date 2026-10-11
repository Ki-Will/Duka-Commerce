import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components';
import './styles.css';
import {
  Home, StorePage, ProductPage, CartsPage, CartDetailPage, OrdersPage, OrderDetailPage,
  LoginPage, RegisterPage, ProfilePage, NotificationsPage, ApplyPage
} from './pages/customer';
import {
  MerchantHome, MerchantProducts, MerchantInventory, MerchantOrders, MerchantOrderDetail,
  MerchantStaff, MerchantSettings, MerchantReports
} from './pages/merchant';
import {
  AdminHome, AdminMerchants, AdminCategories, AdminStores, AdminProducts, AdminOrders,
  AdminPayments, AdminAudit, SupportHome
} from './pages/admin';

function Guard({ roles, children }: { roles?: string[]; children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="notice error">
        Access denied — your role ({user.role}) cannot view this area.
      </div>
    );
  }
  return <>{children}</>;
}

const merchantRoles = ['owner', 'manager', 'staff'];

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Layout>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/store/:storeId" element={<StorePage />} />
            <Route path="/product/:productId" element={<ProductPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
            <Route path="/carts" element={<Guard><CartsPage /></Guard>} />
            <Route path="/cart/:cartId" element={<Guard><CartDetailPage /></Guard>} />
            <Route path="/orders" element={<Guard><OrdersPage /></Guard>} />
            <Route path="/orders/:orderId" element={<Guard><OrderDetailPage /></Guard>} />
            <Route path="/profile" element={<Guard><ProfilePage /></Guard>} />
            <Route path="/notifications" element={<Guard><NotificationsPage /></Guard>} />
            <Route path="/apply" element={<Guard><ApplyPage /></Guard>} />

            <Route path="/merchant" element={<Guard roles={merchantRoles}><MerchantHome /></Guard>} />
            <Route path="/merchant/products" element={<Guard roles={merchantRoles}><MerchantProducts /></Guard>} />
            <Route path="/merchant/inventory" element={<Guard roles={merchantRoles}><MerchantInventory /></Guard>} />
            <Route path="/merchant/orders" element={<Guard roles={merchantRoles}><MerchantOrders /></Guard>} />
            <Route path="/merchant/orders/:orderId" element={<Guard roles={merchantRoles}><MerchantOrderDetail /></Guard>} />
            <Route path="/merchant/staff" element={<Guard roles={['owner', 'manager']}><MerchantStaff /></Guard>} />
            <Route path="/merchant/settings" element={<Guard roles={merchantRoles}><MerchantSettings /></Guard>} />
            <Route path="/merchant/reports" element={<Guard roles={merchantRoles}><MerchantReports /></Guard>} />

            <Route path="/admin" element={<Guard roles={['admin']}><AdminHome /></Guard>} />
            <Route path="/admin/merchants" element={<Guard roles={['admin']}><AdminMerchants /></Guard>} />
            <Route path="/admin/categories" element={<Guard roles={['admin']}><AdminCategories /></Guard>} />
            <Route path="/admin/stores" element={<Guard roles={['admin']}><AdminStores /></Guard>} />
            <Route path="/admin/products" element={<Guard roles={['admin']}><AdminProducts /></Guard>} />
            <Route path="/admin/orders" element={<Guard roles={['admin']}><AdminOrders /></Guard>} />
            <Route path="/admin/payments" element={<Guard roles={['admin']}><AdminPayments /></Guard>} />
            <Route path="/admin/audit" element={<Guard roles={['admin']}><AdminAudit /></Guard>} />

            <Route path="/support" element={<Guard roles={['support', 'admin']}><SupportHome /></Guard>} />

            <Route path="*" element={<div className="notice error">Page not found.</div>} />
          </Routes>
        </Layout>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
