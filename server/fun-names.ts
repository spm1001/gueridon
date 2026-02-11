/**
 * Fun name generator for new project folders.
 *
 * Generates alliterative adjective-noun pairs like "curious-crab" or "mellow-moth".
 * Checks against existing directory names to avoid collisions.
 */

import { readdir } from "node:fs/promises";

// --- Word lists ---
// Curated for: positive/neutral tone, easy to type, no unfortunate combos.

const ADJECTIVES: Record<string, string[]> = {
  a: ["agile", "amber", "airy"],
  b: ["bold", "bright", "brisk"],
  c: ["calm", "clever", "crisp", "curious"],
  d: ["deft", "daring", "dusty"],
  e: ["eager", "even", "easy"],
  f: ["fair", "fleet", "fresh", "fluid"],
  g: ["glad", "gentle", "golden"],
  h: ["happy", "handy", "hazy"],
  i: ["idle", "inky", "icy"],
  j: ["jolly", "jade", "jazzy"],
  k: ["keen", "kind", "knack"],
  l: ["lively", "lucky", "limber"],
  m: ["mellow", "merry", "misty"],
  n: ["neat", "nifty", "nimble"],
  o: ["odd", "opal", "open"],
  p: ["plucky", "polite", "peppy"],
  q: ["quick", "quiet", "quirky"],
  r: ["ready", "rosy", "rapid"],
  s: ["snappy", "smooth", "steady", "sunny"],
  t: ["tidy", "trusty", "tawny"],
  u: ["ultra", "upbeat", "umber"],
  v: ["vivid", "vast", "velvet"],
  w: ["warm", "witty", "wily"],
  x: ["xenial"],
  y: ["young"],
  z: ["zany", "zen", "zippy"],
};

const NOUNS: Record<string, string[]> = {
  a: ["ant", "ape", "axle"],
  b: ["bear", "bee", "bolt", "brook"],
  c: ["crab", "crow", "cube", "cork"],
  d: ["deer", "dove", "drum"],
  e: ["elk", "elm", "ember"],
  f: ["fern", "fox", "frog", "flint"],
  g: ["goat", "gull", "gem"],
  h: ["hare", "hawk", "hive"],
  i: ["ibis", "iris", "isle"],
  j: ["jay", "jade", "jet"],
  k: ["kite", "knot", "koala"],
  l: ["lark", "leaf", "lynx"],
  m: ["moth", "mole", "moss", "mint"],
  n: ["newt", "node", "nest"],
  o: ["owl", "orca", "opal"],
  p: ["pug", "pine", "pond", "puma"],
  q: ["quail", "quartz"],
  r: ["reed", "robin", "rust"],
  s: ["swan", "seal", "spark", "snail"],
  t: ["toad", "tern", "thorn"],
  u: ["urchin"],
  v: ["vole", "vine", "vale"],
  w: ["wren", "wasp", "wolf"],
  x: ["xerus"],
  y: ["yak"],
  z: ["zebra", "zinc"],
};

const LETTERS = Object.keys(ADJECTIVES);

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Generate an alliterative adjective-noun name like "clever-crab". */
function generateName(): string {
  const letter = pick(LETTERS);
  const adj = pick(ADJECTIVES[letter]);
  const noun = pick(NOUNS[letter]);
  return `${adj}-${noun}`;
}

/**
 * Generate a fun folder name that doesn't collide with existing directories.
 * Tries up to 20 times before falling back to a timestamped name.
 */
export async function generateFolderName(scanRoot: string): Promise<string> {
  let existing: Set<string>;
  try {
    const entries = await readdir(scanRoot);
    existing = new Set(entries.map((e) => e.toLowerCase()));
  } catch {
    existing = new Set();
  }

  for (let i = 0; i < 20; i++) {
    const name = generateName();
    if (!existing.has(name.toLowerCase())) return name;
  }

  // Fallback: timestamp-based
  return `project-${Date.now()}`;
}
