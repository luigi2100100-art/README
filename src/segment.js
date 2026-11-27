// Sentence segmentation. Segments always cover the text exactly: joining them
// gives the input back, which the Stage 1 gate checks.

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|et al|etc|vs|approx|Dr|Mr|Mrs|Ms|Prof|No|Inc|Ltd|Co|Corp|Fig|St|U\.S|U\.K|a\.m|p\.m|ca|cf)\.["')\]]?\s*$/i;

/** @returns {Array<[number, number]>} half-open ranges covering text */
export function sentenceRanges(text) {
  const ranges = [];
  for (const s of segmenter.segment(text)) ranges.push([s.index, s.index + s.segment.length]);
  // Merge splits after abbreviations, and whitespace-only segments.
  const out = [];
  for (const r of ranges) {
    const prev = out[out.length - 1];
    const seg = text.slice(r[0], r[1]);
    if (prev && (ABBREV.test(text.slice(prev[0], prev[1])) || !seg.trim())) prev[1] = r[1];
    else out.push([r[0], r[1]]);
  }
  if (out.length > 1 && !text.slice(out[0][0], out[0][1]).trim()) {
    out[1][0] = out[0][0];
    out.shift();
  }
  return out;
}
