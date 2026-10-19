import { useState } from 'react';
import { t } from '../i18n';
import type { ImageryItem } from '../lib/stac';
import { fmtNum, fmtUtc } from '../lib/format';
import { Badge, Button, cx } from './ui';

export default function ImageryCard({
  item,
  active,
  inCompare,
  onFocus,
  onCompare,
  onSave,
}: {
  item: ImageryItem;
  active?: boolean;
  inCompare?: boolean;
  onFocus?: () => void;
  onCompare?: () => void;
  onSave?: () => void;
}) {
  const [imgErr, setImgErr] = useState(false);
  return (
    <article
      onMouseEnter={onFocus}
      className={cx('flex gap-3 rounded border bg-navy-900 p-2 transition', active ? 'border-cyan-400/60 shadow-glow' : 'border-line hover:border-cyan-400/30')}
    >
      <div className="relative h-24 w-24 shrink-0 overflow-hidden rounded bg-ink-950">
        {item.thumbnail && !imgErr ? (
          <img src={item.thumbnail} alt={`Preview ${item.id}`} loading="lazy" onError={() => setImgErr(true)} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center p-1 text-center text-[10px] text-muted">{t('Preview not available')}</div>
        )}
        {item.thumbnail && !imgErr && (
          <span className="absolute bottom-0 left-0 right-0 bg-ink-950/80 px-1 text-center font-mono text-[8px] uppercase tracking-wider text-ok">{t('Genuine preview')}</span>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone="cyan">{item.collectionLabel}</Badge>
          <Badge tone="ok">{t('Free & open')}</Badge>
          {item.coveragePct != null && <Badge tone={item.coveragePct > 95 ? 'ok' : 'warn'}>AOI {fmtNum(item.coveragePct, 0)}%</Badge>}
        </div>
        <div className="truncate font-mono text-[11px] text-white" title={item.id}>{item.id}</div>
        <div className="grid grid-cols-2 gap-x-3 text-[11px] text-muted">
          <span>{fmtUtc(item.datetime)}</span>
          <span>{item.platform}</span>
          <span>GSD {item.gsd}</span>
          <span>{item.cloudCover != null ? `Cloud ${fmtNum(item.cloudCover, 1)}%` : t('Cloud n/a')}</span>
          <span>{item.viewAngle != null ? `Off-nadir ${fmtNum(item.viewAngle, 1)}°` : t('View angle n/a')}</span>
          <span className="truncate">{item.level}</span>
        </div>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {onCompare && <Button variant={inCompare ? 'active' : 'ghost'} onClick={onCompare}>{inCompare ? t('In compare') : t('Compare')}</Button>}
          {onSave && <Button onClick={onSave}>{t('Save to orders')}</Button>}
          {item.selfHref && (
            <a href={item.selfHref} target="_blank" rel="noreferrer">
              <Button>{t('STAC record ↗')}</Button>
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
