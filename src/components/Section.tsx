import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { t } from '../i18n';
import { cx } from './ui';

export interface SectionTab {
  id: string;
  label: string;
  hint?: string;
  el: ReactNode;
}

/** One menu entry with several views, switched by ?tab= (other query params are kept). */
export default function Section({ tabs }: { tabs: SectionTab[] }) {
  const [params, setParams] = useSearchParams();
  const cur = tabs.find((x) => x.id === params.get('tab')) ?? tabs[0];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-line bg-ink-950 px-2 scroll-thin">
        {tabs.map((x) => (
          <button
            key={x.id}
            title={x.hint ? t(x.hint) : undefined}
            onClick={() => setParams({ tab: x.id })}
            className={cx('whitespace-nowrap rounded px-3 py-1.5 text-xs', cur.id === x.id ? 'bg-cyan-400/15 text-cyan-300' : 'text-muted hover:text-white')}
          >
            {t(x.label)}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">{cur.el}</div>
    </div>
  );
}
