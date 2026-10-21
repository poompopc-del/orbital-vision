// Thailand's 77 provinces (geoBoundaries gbOpen ADM1, CC BY 4.0) — loaded on demand, used to
// filter events by province and to tell which province a point falls in.
import { booleanPointInPolygon, point } from '@turf/turf';

const URL_ADM1 = 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/9469f09/releaseData/gbOpen/THA/ADM1/geoBoundaries-THA-ADM1_simplified.geojson';

export const PROVINCE_TH: Record<string, string> = {
  'Amnat Charoen': 'อำนาจเจริญ', 'Ang Thong': 'อ่างทอง', Bangkok: 'กรุงเทพมหานคร', 'Bueng Kan': 'บึงกาฬ', 'Buri Ram': 'บุรีรัมย์',
  Chachoengsao: 'ฉะเชิงเทรา', 'Chai Nat': 'ชัยนาท', Chaiyaphum: 'ชัยภูมิ', Chanthaburi: 'จันทบุรี', 'Chiang Mai': 'เชียงใหม่',
  'Chiang Rai': 'เชียงราย', 'Chon Buri': 'ชลบุรี', Chumphon: 'ชุมพร', Kalasin: 'กาฬสินธุ์', 'Kamphaeng Phet': 'กำแพงเพชร',
  Kanchanaburi: 'กาญจนบุรี', 'Khon Kaen': 'ขอนแก่น', Krabi: 'กระบี่', Lampang: 'ลำปาง', Lamphun: 'ลำพูน', Loei: 'เลย',
  Lopburi: 'ลพบุรี', 'Mae Hong Son': 'แม่ฮ่องสอน', 'Maha Sarakham': 'มหาสารคาม', Mukdahan: 'มุกดาหาร', 'Nakhon Nayok': 'นครนายก',
  'Nakhon Pathom': 'นครปฐม', 'Nakhon Phanom': 'นครพนม', 'Nakhon Ratchasima': 'นครราชสีมา', 'Nakhon Sawan': 'นครสวรรค์',
  'Nakhon Si Thammarat': 'นครศรีธรรมราช', Nan: 'น่าน', Narathiwat: 'นราธิวาส', 'Nong Bua Lam Phu': 'หนองบัวลำภู', 'Nong Khai': 'หนองคาย',
  Nonthaburi: 'นนทบุรี', 'Pathum Thani': 'ปทุมธานี', Pattani: 'ปัตตานี', Phangnga: 'พังงา', Phatthalung: 'พัทลุง', Phayao: 'พะเยา',
  Phetchabun: 'เพชรบูรณ์', Phetchaburi: 'เพชรบุรี', Phichit: 'พิจิตร', Phitsanulok: 'พิษณุโลก', 'Phra Nakhon Si Ayutthaya': 'พระนครศรีอยุธยา',
  Phrae: 'แพร่', Phuket: 'ภูเก็ต', 'Prachin Buri': 'ปราจีนบุรี', 'Prachuap Khiri Khan': 'ประจวบคีรีขันธ์', Ranong: 'ระนอง',
  Ratchaburi: 'ราชบุรี', Rayong: 'ระยอง', 'Roi Et': 'ร้อยเอ็ด', 'Sa Kaeo': 'สระแก้ว', 'Sakon Nakhon': 'สกลนคร', 'Samut Prakan': 'สมุทรปราการ',
  'Samut Sakhon': 'สมุทรสาคร', 'Samut Songkhram': 'สมุทรสงคราม', Saraburi: 'สระบุรี', Satun: 'สตูล', 'Si Sa Ket': 'ศรีสะเกษ',
  'Sing Buri': 'สิงห์บุรี', Songkhla: 'สงขลา', Sukhothai: 'สุโขทัย', 'Suphan Buri': 'สุพรรณบุรี', 'Surat Thani': 'สุราษฎร์ธานี',
  Surin: 'สุรินทร์', Tak: 'ตาก', Trang: 'ตรัง', Trat: 'ตราด', 'Ubon Ratchathani': 'อุบลราชธานี', 'Udon Thani': 'อุดรธานี',
  'Uthai Thani': 'อุทัยธานี', Uttaradit: 'อุตรดิตถ์', Yala: 'ยะลา', Yasothon: 'ยโสธร',
};

export interface Province {
  en: string;
  th: string;
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  bbox: [number, number, number, number];
}

let cache: Promise<Province[]> | null = null;

function bboxOf(g: GeoJSON.Polygon | GeoJSON.MultiPolygon): [number, number, number, number] {
  let w = 180, s = 90, e = -180, n = -90;
  const rings = g.type === 'Polygon' ? g.coordinates : g.coordinates.flat();
  rings.forEach((r) => r.forEach(([x, y]) => { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }));
  return [w, s, e, n];
}

export function loadProvinces(): Promise<Province[]> {
  if (!cache) {
    cache = fetch(URL_ADM1)
      .then((r) => {
        if (!r.ok) throw new Error(`province boundaries HTTP ${r.status}`);
        return r.json();
      })
      .then((g) =>
        (g.features as any[]).map((f) => {
          const en = String(f.properties.shapeName).replace(/ Province$/, '');
          return { en, th: PROVINCE_TH[en] ?? en, geometry: f.geometry, bbox: bboxOf(f.geometry) };
        }),
      )
      .catch((e) => {
        cache = null;
        throw e;
      });
  }
  return cache;
}

/** Province containing the point, or null (outside Thailand / offshore). */
export function provinceAt(list: Province[], lon: number, lat: number): Province | null {
  const p = point([lon, lat]);
  for (const pr of list) {
    const [w, s, e, n] = pr.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (booleanPointInPolygon(p, pr.geometry as any)) return pr;
  }
  return null;
}

/** Thai name for an English (or Thai) province name from a feed. */
export const thProvince = (name?: string | null) => (!name ? '' : PROVINCE_TH[name.replace(/ Province$/, '')] ?? name);
