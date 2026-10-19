import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Panel({ title, right, children, className, bodyClass }: { title?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded-md border border-line bg-navy-900/90 backdrop-blur-sm', className)}>
      {title != null && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="label">{title}</h2>
          {right}
        </header>
      )}
      <div className={cx('p-3', bodyClass)}>{children}</div>
    </section>
  );
}

type Tone = 'idle' | 'info' | 'ok' | 'warn' | 'bad' | 'cyan';
const toneCls: Record<Tone, string> = {
  idle: 'border-line text-muted',
  info: 'border-volt-400/40 text-volt-400',
  ok: 'border-ok/40 text-ok',
  warn: 'border-warn/40 text-warn',
  bad: 'border-bad/40 text-bad',
  cyan: 'border-cyan-400/40 text-cyan-300',
};
export function Badge({ tone = 'idle', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-[1px] font-mono text-[10px] uppercase tracking-wider', toneCls[tone])}>
      {children}
    </span>
  );
}

export function Button({ variant = 'ghost', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'active' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-cyan-400 text-ink-950 hover:bg-cyan-300',
        variant === 'ghost' && 'border border-line text-slate-200 hover:border-cyan-400/50 hover:text-white',
        variant === 'active' && 'border border-cyan-400/60 bg-cyan-400/10 text-cyan-300 shadow-glow',
        variant === 'danger' && 'border border-bad/40 text-bad hover:bg-bad/10',
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx('w-full rounded border border-line bg-ink-900 px-2 py-1.5 text-sm text-white placeholder:text-muted focus:border-cyan-400/60 focus:outline-none', p.className)} />;
}

export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx('w-full rounded border border-line bg-ink-900 px-2 py-1.5 text-sm text-white focus:border-cyan-400/60 focus:outline-none', p.className)} />;
}

export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[minmax(110px,40%)_1fr] gap-2 border-b border-white/5 py-1 text-xs last:border-0">
      <dt className="text-muted">{k}</dt>
      <dd className={cx('text-slate-100', mono && 'font-mono text-[11px]')}>{v ?? <span className="text-muted">—</span>}</dd>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div
      className={cx(
        'rounded border px-3 py-2 text-xs leading-relaxed',
        tone === 'info' && 'border-volt-400/30 bg-volt-500/5 text-slate-300',
        tone === 'warn' && 'border-warn/30 bg-warn/5 text-warn',
        tone === 'bad' && 'border-bad/30 bg-bad/5 text-bad',
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({ code, title, sub, right }: { code: string; title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-cyan-400">{code}</div>
        <h1 className="text-lg font-semibold text-white">{title}</h1>
        {sub && <p className="mt-0.5 max-w-3xl text-xs text-muted">{sub}</p>}
      </div>
      {right}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3 w-3 animate-spin rounded-full border border-cyan-400 border-t-transparent" />;
}
