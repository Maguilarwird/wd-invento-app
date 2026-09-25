import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from './config';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const response = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      });

      let data;
      try {
        data = await response.json();
      } catch {
        setError('Respuesta inválida del servidor.');
        return;
      }

      if (data.success) {
        localStorage.setItem('auth', 'true');
        navigate('/');
        return;
      }

      if (!response.ok && data.error) {
        setError(data.error);
        return;
      }

      setError(data.message || data.error || 'Error en autenticación.');
    } catch (err) {
      setError('No se pudo conectar con el servidor.');
      console.error(err);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <form onSubmit={handleLogin} className="bg-white p-6 rounded shadow-md w-80">
        <h2 className="text-xl font-bold mb-4 text-center">Iniciar Sesión</h2>
        {error && <p className="text-red-500 text-sm mb-4 text-center">{error}</p>}
        <input
          type="text"
          placeholder="Usuario"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          className="w-full p-2 border rounded mb-3"
        />
        <input
          type="password"
          placeholder="Contraseña"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          className="w-full p-2 border rounded mb-4"
        />
        <button
          type="submit"
          className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700"
        >
          Entrar
        </button>
      </form>
    </div>
  );
}