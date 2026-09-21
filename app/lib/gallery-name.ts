/**
 * Quick-add galleries arrive with no meaningful title — the pasted link
 * is all the owner gave us. Rather than inherit the provider's folder
 * name (often a camera dump like "DCIM" or "photos 2024"), a quick-add
 * gallery gets a generated name: three words joined by hyphens, picked
 * uniformly from the list below.
 *
 * No model in the loop — `crypto.getRandomValues` chooses indices, the
 * same primitive Workers exposes at the edge. Three distinct words from
 * this list give tens of millions of combinations, and the slug-unique
 * suffix loop in the create route covers the rare collision anyway.
 */

const WORDS = [
  // light and colour
  'amber', 'ashen', 'auric', 'azure', 'blush', 'brass', 'cinder', 'copper',
  'coral', 'dawn', 'dusk', 'ember', 'fawn', 'flint', 'frost', 'gilt',
  'golden', 'halo', 'hazel', 'ivory', 'jade', 'lapis', 'lilac', 'lucent',
  'mauve', 'milky', 'onyx', 'opal', 'pearl', 'russet', 'sable', 'saffron',
  'scarlet', 'sepia', 'sienna', 'silver', 'slate', 'smoke', 'solar',
  'tawny', 'topaz', 'umber', 'velvet', 'verdant', 'violet',
  // land and water
  'atoll', 'basin', 'bayou', 'bluff', 'brook', 'canyon', 'cave', 'cliff',
  'coast', 'cove', 'creek', 'dale', 'delta', 'dune', 'fell', 'fen',
  'fjord', 'glade', 'glen', 'gorge', 'grove', 'harbor', 'heath', 'inlet',
  'isle', 'knoll', 'lagoon', 'ledge', 'marsh', 'mesa', 'moor', 'peak',
  'quarry', 'reef', 'ridge', 'rill', 'shore', 'sierra', 'strait',
  'summit', 'terrace', 'tide', 'tor', 'vale', 'wadi',
  // weather and air
  'aurora', 'breeze', 'cirrus', 'cloud', 'dew', 'gale', 'gust',
  'haze', 'mist', 'monsoon', 'rain', 'shower', 'squall', 'storm', 'sunlit',
  'tempest', 'thunder', 'zephyr',
  // flora and fauna
  'acacia', 'alder', 'aspen', 'birch', 'briar', 'cedar', 'clover', 'elm',
  'fern', 'fig', 'flax', 'heron', 'holly', 'iris', 'juniper', 'kelp',
  'larch', 'laurel', 'lily', 'linden', 'lotus', 'magnolia',
  'maple', 'moss', 'myrtle', 'oak', 'olive', 'orchid', 'osier', 'palm',
  'pansy', 'poppy', 'reed', 'rowan', 'sage', 'sorrel', 'spruce', 'thorn',
  'thyme', 'tulip', 'vetch', 'vinca', 'willow', 'wren', 'yarrow',
  // stillness and motion
  'arc', 'bend', 'bound', 'bower', 'brink', 'crest', 'curve', 'echo',
  'edge', 'fall', 'field', 'fold', 'ford', 'haven', 'hollow', 'hush',
  'lull', 'meadow', 'murmur', 'nook', 'passage', 'path', 'pool', 'quiet',
  'reach', 'rest', 'rise', 'roam', 'shade', 'shelter', 'sojourn', 'still',
  'strand', 'trail', 'traverse', 'verge', 'wake', 'wander',
] as const

/** One uniform pick from the word list, skipping words already taken. */
const pick = (except: ReadonlySet<string>): string => {
  const values = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(values)
    const word = WORDS[values[0] % WORDS.length]
    if (!except.has(word)) return word
  }
}

/** Three distinct words joined by hyphens — e.g. "ember-tide-fern". The
 *  same string is the gallery slug after slugify, so quick-add URLs read
 *  like the title. */
export const randomGalleryName = (): string => {
  const taken = new Set<string>()
  const a = pick(taken); taken.add(a)
  const b = pick(taken); taken.add(b)
  const c = pick(taken)
  return `${a}-${b}-${c}`
}
