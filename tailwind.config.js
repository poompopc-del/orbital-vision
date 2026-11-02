/** @type {import('tailwindcss').Config} */
// Design tokens — "geospatial workstation" palette.
// The token NAMES are kept from the first theme (ink / navy / cyan …) so every page picks up
// the new look without touching its class names:
//   ink   = app background layers      navy = panels / elevated panels
//   cyan  = accent (muted green)       sel  = selection (amber)
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0f1213', 900: '#141719', 850: '#171b1d', 800: '#1b2023' },
        navy: { 900: '#1b2023', 850: '#1f2427', 800: '#23292d', 700: '#2c3337' },
        line: '#343b3f',
        cyan: { 300: '#b7c6b3', 400: '#91a58d', 500: '#7a8e76' },
        sel: { 300: '#e4c38f', 400: '#d5aa69', 500: '#bf9353' },
        volt: { 400: '#8fa9bd', 500: '#6f8ba1' },
        muted: '#939d9a',
        warn: '#d5aa69',
        bad: '#d0705f',
        ok: '#8fb98a',
        slate: {
          100: '#eef0ef', 200: '#e6e9e7', 300: '#c8cecb', 400: '#a9b1ae', 500: '#939d9a',
          600: '#6f7875', 700: '#4d5553', 800: '#30373a', 900: '#1f2427',
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"IBM Plex Sans Thai"', 'Inter', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', '"IBM Plex Sans Thai"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        sm: '1px',
        DEFAULT: '2px',
        md: '3px',
        lg: '4px',
        xl: '5px',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(145,165,141,0.45)',
        panel: '0 1px 0 rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.25)',
      },
    },
  },
  plugins: [],
};
