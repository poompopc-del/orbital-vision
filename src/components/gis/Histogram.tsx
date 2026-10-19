/** Small histogram from TiTiler statistics ([counts], [edges]) or raw values. */
export default function Histogram({ hist, threshold }: { hist: [number[], number[]]; threshold?: number | null }) {
  const [counts, edges] = hist;
  if (!counts?.length || !edges?.length) return null;
  const max = Math.max(...counts, 1);
  const lo = edges[0], hi = edges[edges.length - 1];
  const W = 260, H = 70;
  const bw = W / counts.length;
  const tx = threshold != null && hi > lo ? ((threshold - lo) / (hi - lo)) * W : null;
  return (
    <svg viewBox={`0 0 ${W} ${H + 12}`} className="w-full">
      {counts.map((c, i) => (
        <rect key={i} x={i * bw + 0.5} y={H - (c / max) * H} width={Math.max(1, bw - 1)} height={(c / max) * H} fill="#22d3ee" opacity={0.7} />
      ))}
      {tx != null && tx >= 0 && tx <= W && <line x1={tx} x2={tx} y1={0} y2={H} stroke="#f5b84b" strokeWidth={1.5} strokeDasharray="3 2" />}
      <text x={0} y={H + 10} fontSize="8" fill="#8b98ab" fontFamily="JetBrains Mono, monospace">{lo.toFixed(2)}</text>
      <text x={W} y={H + 10} fontSize="8" fill="#8b98ab" textAnchor="end" fontFamily="JetBrains Mono, monospace">{hi.toFixed(2)}</text>
    </svg>
  );
}

export function histFromValues(values: number[], lo: number, hi: number, bins = 30): [number[], number[]] {
  const counts = new Array(bins).fill(0);
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + ((hi - lo) * i) / bins);
  for (const v of values) {
    const k = Math.floor(((v - lo) / (hi - lo)) * bins);
    if (k >= 0 && k < bins) counts[k]++;
  }
  return [counts, edges];
}
