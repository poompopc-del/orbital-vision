export const fmtUtc = (d: Date | string | null | undefined) => {
  if (!d) return '—';
  const x = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(x.getTime())) return '—';
  return x.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
};

export const fmtLocal = (d: Date | string) => {
  const x = typeof d === 'string' ? new Date(d) : d;
  return x.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
};

export const fmtNum = (n: number | null | undefined, digits = 1) =>
  n == null || isNaN(n) ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });

export const fmtLatLon = (lat: number, lon: number) =>
  `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
