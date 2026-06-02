/**
 * Curated, verified Unsplash photography for lab2date.
 * Every ID below was HTTP-checked to resolve (200) on the Unsplash CDN.
 * Real photography — no flat clip-art.
 */

const U = (id: string, w = 800, q = 72) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&q=${q}`;

// Pools of lab/science photos, loosely themed to instrument category.
const POOLS: Record<string, string[]> = {
  microscope: ['1607619056574-7b8d3ee536b2', '1576091160550-2173dba999ef', '1581091226825-a6a2a5aee158'],
  centrifuge: ['1581093450021-4a7360e9a6b5', '1532094349884-543bc11b234d', '1567427017947-545c5f8d16ad'],
  pcr:        ['1576086213369-97a306d36557', '1581092160607-ee22621dd758', '1551288049-bebda4e38f71'],
  hplc:       ['1628595351029-c2bf17511435', '1576671081837-49000212a370', '1530026405186-ed1f139313f8'],
  massspec:   ['1532187863486-abf9dbad1b69', '1565071783280-719b01b29912', '1551601651-2a8555f1a136'],
  balance:    ['1581092160607-ee22621dd758', '1518152006812-edab29b069ac', '1559757175-5700dde675bc'],
};

const DEFAULT_POOL = ['1582719508461-905c673771fd', '1518152006812-edab29b069ac', '1614935151651-0bea6508db6b'];

/** Deterministic pick so the same product always gets the same photo. */
function pick(pool: string[], seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return pool[h % pool.length];
}

export function productImage(
  illustration: string | null | undefined,
  seed: string,
  w = 800,
): string {
  const pool = (illustration && POOLS[illustration]) || DEFAULT_POOL;
  return U(pick(pool, seed), w);
}

export function blogCover(seed: string, w = 1000): string {
  const pool = ['1614935151651-0bea6508db6b', '1518152006812-edab29b069ac', '1559757175-5700dde675bc', '1532187863486-abf9dbad1b69', '1565071783280-719b01b29912'];
  return U(pick(pool, seed), w);
}

// Hero ambient imagery.
export const HERO_IMAGES = {
  ambient: U('1582719508461-905c673771fd', 1400, 70),
  microscope: U('1607619056574-7b8d3ee536b2', 700),
  centrifuge: U('1581093450021-4a7360e9a6b5', 700),
  instrument: U('1628595351029-c2bf17511435', 700),
};

export const CASE_STUDY_IMAGES = ['1581091226825-a6a2a5aee158', '1532187863486-abf9dbad1b69'].map((id) => U(id, 1200, 72));
export function caseImage(seed: string) {
  return blogCover(seed, 1200);
}
