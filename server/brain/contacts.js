import { store } from '../store.js';

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/^(the|my|dr\.?|doctor|mr\.?|mrs\.?|ms\.?|miss)\s+/g, '')
    .replace(/[^a-z0-9@\s]/g, '')
    .trim();

const names = (c) => [c.name, ...(c.aliases || [])].map(norm).filter(Boolean);

// -> { contact } | { none: true } | { many: [contacts] }
export function resolveContact(query) {
  const q = norm(query);
  const contacts = store.data.contacts;
  if (!q) return { none: true };

  const exact = contacts.filter((c) => names(c).includes(q));
  if (exact.length === 1) return { contact: exact[0] };
  if (exact.length > 1) return { many: exact };

  const loose = contacts.filter((c) =>
    names(c).some((n) => n.split(/\s+/).includes(q) || n.startsWith(q) || (q.length > 2 && n.includes(q))),
  );
  if (loose.length === 1) return { contact: loose[0] };
  if (loose.length > 1) return { many: loose };
  return { none: true };
}

export function contactNames() {
  return store.data.contacts.map((c) => c.name);
}
