// Types for the landing engine (plain JS ported from the Shelter landing; see shell.js).
export interface LandingGame {
  name: string;
  slug: string;
  /** [accent, card background] */
  c: [string, string];
  /** the line above the title on the card (leading brands) */
  plat: string[];
  /** the line under the title on the card */
  fa: string;
  /** the category's photo (seen through frosted glass), desktop / phone sizes */
  wide?: string | null;
  artSm?: string | null;
}

export interface LandingConfig {
  links: Record<string, string>;
  games: LandingGame[];
  text: Record<string, string>;
  hub: { label: string; lat: number; lon: number } | null;
  lanes: { label: string; lat: number; lon: number }[];
}

export declare function startLanding(config: LandingConfig): { dispose(): void };
