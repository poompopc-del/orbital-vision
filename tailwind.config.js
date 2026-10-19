/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#07090c', 900: '#0b0e12', 850: '#0e1218', 800: '#121821' },
        navy: { 900: '#0b1524', 850: '#0e1a2c', 800: '#122136', 700: '#1a2d48' },
        line: 'rgba(148, 178, 214, 0.12)',
        cyan: { 300: '#7ce7f7', 400: '#22d3ee', 500: '#06b6d4' },
        volt: { 400: '#4f8dff', 500: '#2f6bff' },
        muted: '#8b98ab',
        warn: '#f5b84b',
        bad: '#f2665a',
        ok: '#4fd18b',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(34,211,238,0.35), 0 0 18px rgba(34,211,238,0.12)',
      },
    },
  },
  plugins: [],
};
