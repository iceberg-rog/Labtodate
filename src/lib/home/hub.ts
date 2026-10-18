import type { GeoPoint } from '@/lib/home-sections';

/**
 * Where the homepage globe puts the hub when Admin → Homepage leaves it empty:
 * the issuing city of Settings → Company (COMPANY_CITY), labelled with the site
 * name. Coordinates come from the small table below (cities a Dutch or EU lab
 * dealer is likely to sit in); an unknown city falls back to the capital of the
 * VAT home country — the label still names the real city, and the exact spot
 * can be typed in Admin → Homepage (name|latitude|longitude).
 */
const CITIES: Record<string, [number, number]> = {
  // the Netherlands
  amsterdam: [52.37, 4.9], rotterdam: [51.92, 4.48], 'den haag': [52.08, 4.3], 'the hague': [52.08, 4.3], "'s-gravenhage": [52.08, 4.3],
  utrecht: [52.09, 5.12], eindhoven: [51.44, 5.48], zoetermeer: [52.06, 4.49], leiden: [52.16, 4.49], delft: [52.01, 4.36],
  haarlem: [52.38, 4.64], almere: [52.37, 5.22], amersfoort: [52.16, 5.39], arnhem: [51.98, 5.91], nijmegen: [51.84, 5.86],
  groningen: [53.22, 6.57], tilburg: [51.56, 5.09], breda: [51.59, 4.78], 'den bosch': [51.69, 5.3], "'s-hertogenbosch": [51.69, 5.3],
  maastricht: [50.85, 5.69], enschede: [52.22, 6.89], zwolle: [52.52, 6.08], apeldoorn: [52.21, 5.97], dordrecht: [51.81, 4.67],
  gouda: [52.01, 4.71], alkmaar: [52.63, 4.75], hilversum: [52.22, 5.18], wageningen: [51.97, 5.67], venlo: [51.37, 6.17],
  schiedam: [51.92, 4.4], 'alphen aan den rijn': [52.13, 4.66], 'capelle aan den ijssel': [51.93, 4.58], rijswijk: [52.04, 4.32],
  amstelveen: [52.3, 4.86], hoofddorp: [52.3, 4.69], schiphol: [52.31, 4.76], oss: [51.77, 5.52], helmond: [51.48, 5.66], deventer: [52.25, 6.16],
  // elsewhere in Europe
  brussels: [50.85, 4.35], antwerp: [51.22, 4.4], ghent: [51.05, 3.72], leuven: [50.88, 4.7], luxembourg: [49.61, 6.13],
  berlin: [52.52, 13.4], hamburg: [53.55, 9.99], munich: [48.14, 11.58], frankfurt: [50.11, 8.68], cologne: [50.94, 6.96], düsseldorf: [51.23, 6.78],
  paris: [48.86, 2.35], lyon: [45.76, 4.84], london: [51.51, -0.13], cambridge: [52.21, 0.12], dublin: [53.35, -6.26],
  madrid: [40.42, -3.7], barcelona: [41.39, 2.17], lisbon: [38.72, -9.14], rome: [41.9, 12.5], milan: [45.46, 9.19],
  vienna: [48.21, 16.37], zurich: [47.38, 8.54], basel: [47.56, 7.59], copenhagen: [55.68, 12.57], stockholm: [59.33, 18.07],
  oslo: [59.91, 10.75], helsinki: [60.17, 24.94], warsaw: [52.23, 21.01], prague: [50.08, 14.44], budapest: [47.5, 19.04],
};

/** Capital of each VAT home country (ISO 3166-1 alpha-2), for a city not in the table. */
const CAPITALS: Record<string, [number, number]> = {
  NL: [52.37, 4.9], BE: [50.85, 4.35], LU: [49.61, 6.13], DE: [52.52, 13.4], FR: [48.86, 2.35], GB: [51.51, -0.13], IE: [53.35, -6.26],
  ES: [40.42, -3.7], PT: [38.72, -9.14], IT: [41.9, 12.5], AT: [48.21, 16.37], CH: [46.95, 7.45], DK: [55.68, 12.57], SE: [59.33, 18.07],
  NO: [59.91, 10.75], FI: [60.17, 24.94], PL: [52.23, 21.01], CZ: [50.08, 14.44], HU: [47.5, 19.04], GR: [37.98, 23.73], RO: [44.43, 26.1],
};

const key = (city: string) => city.trim().toLowerCase().replace(/\s+/g, ' ');

/** The hub for `city` (and `homeCountry` when the city is unknown), labelled “<site> · <city>”. */
export function hubFromCompany(site: string, city: string, homeCountry: string): GeoPoint {
  const c = city.trim();
  const at = CITIES[key(c)] ?? CAPITALS[homeCountry.trim().toUpperCase()] ?? CAPITALS.NL;
  return { label: (c ? `${site} · ${c}` : site).slice(0, 40), lat: at[0], lon: at[1] };
}
