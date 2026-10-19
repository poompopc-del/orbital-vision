import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { cx } from './ui';

/** Keeps the three levels apart: orbital pass ≠ imaging opportunity ≠ confirmed acquisition. */
export default function PassClassNote({ active }: { active: 'pass' | 'opportunity' }) {
  const row = (id: string, label: string, text: string, on: boolean) => (
    <div key={id} className={cx('rounded border px-2 py-1.5', on ? 'border-cyan-400/50 bg-cyan-400/5' : 'border-line')}>
      <div className={cx('text-[11px] font-semibold', on ? 'text-cyan-300' : 'text-slate-300')}>{t(label)}</div>
      <div className="text-[10px] leading-snug text-muted">{t(text)}</div>
    </div>
  );
  return (
    <div className="space-y-1">
      {row('1', 'Predicted pass', 'Satellite above the horizon of a point (SGP4 from public TLE). Shown in Pass view.', active === 'pass')}
      {row('2', 'Imaging opportunity', 'Nominal swath could cover the AOI given documented sensor limits. Shown in Coverage Planner and Imaging view.', active === 'opportunity')}
      {row('3', 'Confirmed acquisition', 'Only a provider can confirm. Nothing on this page is confirmed — request it via New Acquisition.', false)}
      <div className="flex gap-3 pt-0.5 text-[11px]">
        <Link to="/coverage" className="text-cyan-300 underline">{t('Coverage Planner')}</Link>
        <Link to="/acquire" className="text-cyan-300 underline">{t('New Acquisition')}</Link>
        <span className="text-muted">{t('Times: Thailand time (Asia/Bangkok, UTC+7)')}</span>
      </div>
    </div>
  );
}
