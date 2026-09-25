// main.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css'; // Tailwind CSS
import './App.css';   // Tus estilos personalizados
import App from './App';
import Login from './Login'; // 👈 Asegúrate de crear este archivo
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

// Ruta protegida
function ProtectedRoute({ children }) {
  const isAuthenticated = localStorage.getItem('auth') === 'true';
  return isAuthenticated ? children : <Navigate to="/login" />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        {/* Ruta pública */}
        <Route path="/login" element={<Login />} />

        {/* Ruta protegida */}
        <Route
          path="/*"
          element={
            <ProtectedRoute>
              <App />
            </ProtectedRoute>
          }
        />

        {/* Redirección por defecto */}
        <Route path="*" element={<Navigate to="/login" />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);