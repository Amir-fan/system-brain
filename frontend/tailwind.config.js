/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef3ff',
          100: '#e0e9ff',
          200: '#c6d7ff',
          300: '#a3bcff',
          400: '#7d97fb',
          500: '#5b72f5',
          600: '#4f5ee0',
          700: '#424bc4',
          800: '#343a8f',
          900: '#2c3270',
        },
        surface: {
          DEFAULT: '#f6f7fb',
          card: '#ffffff',
          line: '#e7e8ef',
        },
        success: {
          100: '#e5f9ed',
          600: '#17a261',
          700: '#128453',
        },
        muted: {
          DEFAULT: '#5f6470',
          soft: '#8b90a0',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Noto Sans Arabic', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 2px rgba(16,24,40,0.04), 0 1px 3px rgba(16,24,40,0.06)',
        lift: '0 6px 20px rgba(16,24,40,0.08)',
      },
      borderRadius: {
        xl2: '16px',
      },
    },
  },
  plugins: [],
};