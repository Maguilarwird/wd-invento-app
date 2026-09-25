/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        navy: '#06122A',
        canvas: '#EFEFF2',
        surface: '#FAFAFA',
        line: '#DBDBE0',
        accent: '#22EDA3',
        ink: {
          DEFAULT: '#06122A',
          muted: 'rgba(6, 18, 42, 0.55)',
          soft: 'rgba(6, 18, 42, 0.35)',
        },
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'sans-serif',
        ],
      },
      borderRadius: {
        panel: '14px',
      },
      boxShadow: {
        panel: '0 12px 32px rgba(6, 18, 42, 0.12)',
      },
    },
  },
  plugins: [],
};
