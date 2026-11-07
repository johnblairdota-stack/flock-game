// Answer matching: turns free-text answers into groups of "same" answers.
// Goal: "The Beatles", "beatles", "Beatles!" and "beatels" all land together,
// while "cat" and "car" stay apart.

const NUMBER_WORDS = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6',
  seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12',
  thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20', hundred: '100', thousand: '1000',
};

const STOP_PREFIXES = ['the ', 'a ', 'an ', 'my ', 'mr ', 'mrs ', 'ms ', 'dr '];

function singular(word) {
  if (word.length <= 3) return word;
  if (/(ss|us|is)$/.test(word)) return word; // glass, bus, tennis
  if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';
  if (/(ches|shes|xes|zes|sses)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith('oes')) return word.slice(0, -2);
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

export function normalize(text) {
  let s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '') // don't -> dont, mcdonald's -> mcdonalds
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of STOP_PREFIXES) {
      if (s.startsWith(p) && s.length > p.length) { s = s.slice(p.length); changed = true; }
    }
  }
  const words = s.split(' ').filter(Boolean).map(w => NUMBER_WORDS[w] || singular(w));
  return words.join(' ');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

// How many typos we forgive, by word length. Short words must match exactly
// (cat vs car, red vs rod).
function tolerance(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

export function similar(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // Ignore spaces: "ice cream" vs "icecream"
  const ca = a.replace(/ /g, ''), cb = b.replace(/ /g, '');
  if (ca === cb) return true;
  const tol = tolerance(Math.min(ca.length, cb.length));
  if (tol === 0) return false;
  if (Math.abs(ca.length - cb.length) > tol) return false;
  return levenshtein(ca, cb) <= tol;
}

/**
 * Group answers.
 * @param {Record<string,string>} answers playerId -> raw text (blank = no answer)
 * @param {{fuzzy?: boolean}} opts
 * @returns {{key:string,label:string,members:string[]}[]} biggest groups first
 */
export function groupAnswers(answers, opts = {}) {
  const fuzzy = opts.fuzzy !== false;
  const ids = Object.keys(answers).filter(id => String(answers[id] || '').trim());
  const norm = Object.fromEntries(ids.map(id => [id, normalize(answers[id]) || String(answers[id]).trim().toLowerCase()]));

  // Union-find over players
  const parent = Object.fromEntries(ids.map(id => [id, id]));
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = norm[ids[i]], b = norm[ids[j]];
      if (a === b || (fuzzy && similar(a, b))) union(ids[i], ids[j]);
    }
  }

  const buckets = {};
  for (const id of ids) (buckets[find(id)] ||= []).push(id);

  const groups = Object.values(buckets).map(members => ({
    key: norm[members[0]],
    label: pickLabel(members.map(m => answers[m])),
    members,
  }));
  groups.sort((a, b) => b.members.length - a.members.length || a.label.localeCompare(b.label));
  return groups;
}

// Most common spelling wins; ties go to the nicest-looking (has capitals, shortest).
function pickLabel(raws) {
  const counts = new Map();
  for (const r of raws) {
    const t = String(r).trim().replace(/\s+/g, ' ');
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1]
      || Number(/[A-Z]/.test(b[0])) - Number(/[A-Z]/.test(a[0]))
      || a[0].length - b[0].length)[0][0];
}
