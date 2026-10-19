import type { ImageryItem } from '../../lib/stac';
import { sensorOf } from '../../lib/spectral';

/** Pre-comparison checks between two scenes (sensor, resolution, dates, clouds, season). */
export function compareWarnings(a: ImageryItem, b: ImageryItem): string[] {
  const w: string[] = [];
  if (a.collection !== b.collection) w.push(`Different sensors (${a.collectionLabel} vs ${b.collectionLabel}): radiometry and resolution differ — compare with caution.`);
  if (sensorOf(a) !== sensorOf(b) && (sensorOf(a) === 's1' || sensorOf(b) === 's1')) w.push('Optical and SAR cannot be compared with the same index.');
  if (a.gsd !== b.gsd) w.push(`Different nominal resolution (${a.gsd} vs ${b.gsd}); data are resampled to a common web-mercator grid.`);
  const da = new Date(a.datetime), db = new Date(b.datetime);
  if (db < da) w.push('Scene B is older than scene A — “after” should normally be B.');
  const months = Math.abs((db.getFullYear() - da.getFullYear()) * 12 + db.getMonth() - da.getMonth()) % 12;
  if (months >= 3 && months <= 9) w.push('Scenes are from different seasons — vegetation and water changes may be seasonal.');
  [a, b].forEach((x, i) => {
    if (x.cloudCover != null && x.cloudCover > 20) w.push(`Scene ${i ? 'B' : 'A'} has ${x.cloudCover.toFixed(0)}% scene cloud cover — clouds and shadows cause false changes.`);
  });
  if (a.viewAngle != null && b.viewAngle != null && Math.abs(a.viewAngle - b.viewAngle) > 10) w.push('Viewing angles differ by more than 10°.');
  w.push('Co-registration is not re-done here: both scenes are used as delivered (L2A / C2 L2 / RTC geocoding).');
  return w;
}
