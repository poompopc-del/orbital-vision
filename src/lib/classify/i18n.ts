import { useLang } from '../../i18n';
import { fmtArea } from '../area';

/** Inline bilingual text: Thai is written natively next to the English, not machine-translated. */
export const tl = (en: string, th: string) => (useLang.getState().lang === 'th' ? th : en);
export const isTh = () => useLang.getState().lang === 'th';
/** Area in ตร.กม. (ไร่) / km² (rai) — the only area units used in results. */
export const area = (km2: number) => fmtArea(km2, 'km2', isTh());
export const nameOf = (o: { en: string; th: string }) => (isTh() ? o.th : o.en);
