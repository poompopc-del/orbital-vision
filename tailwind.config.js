/** @type {import('tailwindcss').Config} */
// Design tokens — "geospatial workstation" palette (graphite + teal).
// The token NAMES are kept from the first theme (ink / navy / cyan …) so every page picks up
// the look without touching its class names:
//   ink   = app background layers (deep charcoal)   navy = panels / elevated panels (graphite)
//   cyan  = accent: active state, selection, data being processed (teal / cyan)
//   sel   = selection highlight on imagery (amber)  warn = needs attention (amber)
//   bad   = errors / critical only (red)
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { 950: '#0c0e10', 900: '#111417', 850: '#15191c', 800: '#191d21' },
        navy: { 900: '#181c20', 850: '#1d2226', 800: '#22282d', 700: '#2b3238' },
        line: '#2c3339',
        cyan: { 300: '#7fe3d6', 400: '#2fc4b2', 500: '#22a596' },
        sel: { 300: '#f0cf8e', 400: '#e2ad55', 500: '#c99440' },
        volt: { 400: '#7fb2d6', 500: '#5d93ba' },
        muted: '#8b969c',
        warn: '#e2ad55',
        bad: '#e5594f',
        ok: '#5fc48e',
        slate: {
          100: '#eef1f2', 200: '#e3e7e9', 300: '#c3cacd', 400: '#a3acb0', 500: '#8b969c',
          600: '#68737a', 700: '#48525a', 800: '#2e353b', 900: '#1d2226',
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
        glow: '0 0 0 1px rgba(47,196,178,0.45)',
        panel: '0 1px 0 rgba(0,0,0,0.25), 0 6px 18px rgba(0,0,0,0.25)',
        float: '0 1px 0 rgba(255,255,255,0.04) inset, 0 8px 24px rgba(0,0,0,0.45)',
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [],
};
