/**
 * Where a document is filed.
 *
 * Documents are organised **Child → Category Folder → File**. Nothing is ever
 * filed under the account that uploaded it, which is what the module used to do.
 *
 * The folder list and the routing rules live in `config/documentCategories.json`
 * so the backend and the frontend resolve a document to the same folder. This
 * module is the backend's copy of that resolver; `frontend/src/utils/documentCategory.ts`
 * mirrors it, and a test pins the two JSON files byte-identical.
 *
 * @module utils/documentCategory
 */

const definition = require('../config/documentCategories.json');

/** The folder names, in the order the UI shows them. */
const DOCUMENT_FOLDERS = Object.freeze([...definition.folders]);

/** The fallback folder for anything the rules do not recognise. */
const DEFAULT_DOCUMENT_FOLDER = definition.defaultFolder;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve the folder a document belongs in.
 *
 * Three passes, most explicit signal first, so a keyword in a title can never
 * override a category that was set deliberately:
 *
 *   1. an exact `type` match  (TRI / Anecdotal Report / Quarterly Progress Report …)
 *   2. an exact `category` match  (Medical / Assessment / Admission …)
 *   3. a keyword appearing anywhere in the title, type, category or file name
 *
 * The first rule to match within a pass wins; if no rule matches at all the
 * document lands in the default folder rather than becoming unfindable.
 *
 * @param {{title?: unknown, type?: unknown, category?: unknown, fileName?: unknown}} document
 * @returns {string} One of `DOCUMENT_FOLDERS`.
 */
function categoryForDocument(document) {
  if (!document || typeof document !== 'object') return DEFAULT_DOCUMENT_FOLDER;

  const type = normalizeText(document.type);
  const category = normalizeText(document.category);
  const haystack = [document.title, document.type, document.category, document.fileName]
    .map(normalizeText)
    .filter(Boolean)
    .join(' | ');

  if (type) {
    for (const rule of definition.rules) {
      if ((rule.types || []).some((candidate) => normalizeText(candidate) === type)) return rule.folder;
    }
  }

  if (category) {
    for (const rule of definition.rules) {
      if ((rule.categories || []).some((candidate) => normalizeText(candidate) === category)) return rule.folder;
    }
  }

  if (haystack) {
    for (const rule of definition.rules) {
      if ((rule.keywords || []).some((keyword) => haystack.includes(normalizeText(keyword)))) return rule.folder;
    }
  }

  return DEFAULT_DOCUMENT_FOLDER;
}

/**
 * Coerce a value that may already be a folder name into one.
 *
 * A stored folder is trusted when it is a real folder, so a document filed
 * before a rule changed does not silently move; anything else is resolved from
 * the document's own fields.
 *
 * @param {{documentCategory?: unknown}} document
 * @returns {string}
 */
function folderForDocument(document) {
  const stored = normalizeText(document?.documentCategory);
  if (stored) {
    const known = DOCUMENT_FOLDERS.find((folder) => normalizeText(folder) === stored);
    if (known) return known;
  }
  return categoryForDocument(document);
}

/**
 * The folder a given document `type` belongs in.
 *
 * Publishers (TRI, Anecdotal Report, QPR) file the record they just generated,
 * so they need the folder name before a document row exists. Resolving it from
 * the rules instead of writing the literal means renaming a folder in the JSON
 * cannot silently strand those documents in the old folder.
 *
 * @param {string} type
 * @returns {string}
 */
function folderForType(type) {
  return categoryForDocument({ type });
}

module.exports = {
  DOCUMENT_FOLDERS,
  DEFAULT_DOCUMENT_FOLDER,
  categoryForDocument,
  folderForDocument,
  folderForType,
  definition,
};
