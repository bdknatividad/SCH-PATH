/**
 * Where a document is filed — the frontend half.
 *
 * Documents are organised **Child → Category Folder → File**, never by the
 * account that uploaded them. The folder list and the routing rules live in
 * `app/config/documentCategories.json`, kept byte-identical to
 * `backend/src/config/documentCategories.json`; this file mirrors
 * `backend/src/utils/documentCategory.js` so the UI files a document the same
 * way the API does. The backend is the enforcement point — it persists the
 * resolved folder — and this is what the folder view groups by.
 */

import definition from '@/app/config/documentCategories.json';

export const DOCUMENT_FOLDERS: string[] = [...definition.folders];

export const DEFAULT_DOCUMENT_FOLDER: string = definition.defaultFolder;

function normalizeText(value: unknown): string {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve the folder a document belongs in.
 *
 * Three passes, most explicit signal first, so a keyword in a title can never
 * override a category that was set deliberately: exact `type`, then exact
 * `category`, then a keyword in the title/type/category/file name.
 */
export function categoryForDocument(document: {
  title?: unknown;
  type?: unknown;
  category?: unknown;
  fileName?: unknown;
} | null | undefined): string {
  if (!document || typeof document !== 'object') return DEFAULT_DOCUMENT_FOLDER;

  const type = normalizeText(document.type);
  const category = normalizeText(document.category);
  const haystack = [document.title, document.type, document.category, document.fileName]
    .map(normalizeText)
    .filter(Boolean)
    .join(' | ');

  if (type) {
    for (const rule of definition.rules) {
      if ((rule.types || []).some((candidate: string) => normalizeText(candidate) === type)) return rule.folder;
    }
  }

  if (category) {
    for (const rule of definition.rules) {
      if ((rule.categories || []).some((candidate: string) => normalizeText(candidate) === category)) return rule.folder;
    }
  }

  if (haystack) {
    for (const rule of definition.rules) {
      if ((rule.keywords || []).some((keyword: string) => haystack.includes(normalizeText(keyword)))) return rule.folder;
    }
  }

  return DEFAULT_DOCUMENT_FOLDER;
}

/**
 * The folder a document is filed in.
 *
 * A folder the API already persisted is trusted — a document filed before a rule
 * changed must not silently move — and anything else is resolved from the
 * document's own fields, which is what files a legacy row correctly.
 */
export function folderForDocument(document: {
  documentCategory?: unknown;
  title?: unknown;
  type?: unknown;
  category?: unknown;
  fileName?: unknown;
} | null | undefined): string {
  const stored = normalizeText(document?.documentCategory);
  if (stored) {
    const known = DOCUMENT_FOLDERS.find((folder) => normalizeText(folder) === stored);
    if (known) return known;
  }
  return categoryForDocument(document);
}
