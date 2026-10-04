const KIND_BY_MIME = [
  [/^application\/vnd\.google-apps\.folder$/, 'folder'],
  [/pdf$/, 'pdf'],
  [/(document|msword|wordprocessing|rtf|opendocument\.text)/, 'doc'],
  [/(spreadsheet|excel|csv|opendocument\.spreadsheet)/, 'sheet'],
  [/(presentation|powerpoint|opendocument\.presentation)/, 'slides'],
  [/^image\//, 'image'],
  [/^video\//, 'video'],
  [/^audio\//, 'audio'],
  [/(zip|tar|gzip|7z|rar|compressed)/, 'archive'],
  [/^text\//, 'text'],
  [/(json|xml|javascript|x-sh)/, 'code'],
  [/(step|stl|dwg|dxf|cad|sldprt|obj|fbx)/i, 'cad'],
];

export function kindOf(mimeType = '', name = '') {
  for (const [re, kind] of KIND_BY_MIME) if (re.test(mimeType)) return kind;
  if (/\.(stl|step|stp|dwg|dxf|sldprt|f3d|obj)$/i.test(name)) return 'cad';
  if (/\.(md|txt|log)$/i.test(name)) return 'text';
  return 'file';
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function matchByName(items, spec, key = 'name') {
  const q = String(spec || '').trim().toLowerCase();
  if (!q) return [];
  const exact = items.filter((i) => i[key].toLowerCase() === q);
  if (exact.length) return exact;
  const starts = items.filter((i) => i[key].toLowerCase().startsWith(q));
  if (starts.length) return starts;
  return items.filter((i) => i[key].toLowerCase().includes(q));
}

// Resolve a spoken folder reference ("Research", "Research/Reactor") against a flat folder list.
export function resolveFolder(folders, spec) {
  const q = String(spec || '').trim();
  if (!q || /^(my drive|root|drive|the root)$/i.test(q)) return { id: 'root', name: 'My Drive', path: 'My Drive' };
  const segments = q.split(/\s*[/>]\s*/).filter(Boolean);
  const last = segments[segments.length - 1];
  let hits = matchByName(folders, last);
  if (segments.length > 1) {
    const tail = segments.join(' / ').toLowerCase();
    const full = hits.filter((f) => f.path.toLowerCase().endsWith(tail));
    if (full.length) hits = full;
  }
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) return null;
  const exact = hits.filter((h) => h.name.toLowerCase() === last.toLowerCase());
  if (exact.length === 1) return exact[0];
  return { ambiguous: hits.slice(0, 5) };
}
