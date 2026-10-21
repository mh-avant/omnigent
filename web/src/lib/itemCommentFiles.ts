// Attachments on item-comment drafts. Drafts live in localStorage, which can't
// hold files, so each attachment's bytes go to IndexedDB under an id the draft
// stores. A reload or a second tab reads them back; File objects created in
// this page are reused as-is, so the send path's upload cache still applies.
// Without IndexedDB (a private window, say) attachments last until reload.

const DATABASE_NAME = "omnigent-item-comment-files";
// Set once a draft has saved a file, so pages that never did skip the sweep.
const USED_MARKER_KEY = "omnigent.itemCommentFiles.used";
const STORE_NAME = "files";
// A file saved this recently may belong to a draft another tab is still writing.
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

interface StoredDraftFile {
  id: string;
  name: string;
  type: string;
  lastModified: number;
  bytes: ArrayBuffer;
  savedAt: number;
}

const filesInPage = new Map<string, File>();
const idsByFile = new WeakMap<File, string>();
let nextFileSeq = 0;
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
  databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open draft files"));
  }).catch((error: unknown) => {
    databasePromise = null;
    throw error;
  });
  return databasePromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Draft file write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Draft file write aborted"));
  });
}

/**
 * The id a draft stores for `file`, saving its bytes for later pages. The same
 * File keeps its id, so saving a draft again doesn't copy its files again.
 */
export function rememberDraftFile(file: File): string {
  const known = idsByFile.get(file);
  if (known !== undefined) return known;
  nextFileSeq += 1;
  const id = `${Date.now().toString(36)}-${nextFileSeq}-${Math.random().toString(36).slice(2, 8)}`;
  idsByFile.set(file, id);
  filesInPage.set(id, file);
  try {
    localStorage.setItem(USED_MARKER_KEY, "1");
  } catch {
    // Without the marker the next page just skips its sweep.
  }
  void file
    .arrayBuffer()
    .then((bytes) =>
      withStore("readwrite", (store) =>
        store.put({
          id,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          bytes,
          savedAt: Date.now(),
        } satisfies StoredDraftFile),
      ),
    )
    .catch(() => {
      // Kept in this page only; the draft loses the file on reload.
    });
  return id;
}

/** The file saved under `id`, or null when it is gone. */
export async function loadDraftFile(id: string): Promise<File | null> {
  const inPage = filesInPage.get(id);
  if (inPage !== undefined) return inPage;
  try {
    const stored = await withStore<StoredDraftFile | undefined>("readonly", (store) =>
      store.get(id),
    );
    if (!stored) return null;
    const file = new File([stored.bytes], stored.name, {
      type: stored.type,
      lastModified: stored.lastModified,
    });
    idsByFile.set(file, id);
    filesInPage.set(id, file);
    return file;
  } catch {
    return null;
  }
}

/** Drops files no draft uses any more. */
export function forgetDraftFiles(ids: Iterable<string>): void {
  for (const id of ids) {
    filesInPage.delete(id);
    void withStore("readwrite", (store) => store.delete(id)).catch(() => {});
  }
}

/** Deletes saved files that no draft in any session refers to. */
export async function sweepDraftFiles(referenced: ReadonlySet<string>): Promise<void> {
  try {
    if (localStorage.getItem(USED_MARKER_KEY) !== "1") return;
    const stored = await withStore<StoredDraftFile[]>("readonly", (store) => store.getAll());
    const cutoff = Date.now() - SWEEP_MIN_AGE_MS;
    const unused = stored
      .filter((file) => !referenced.has(file.id) && file.savedAt < cutoff)
      .map((file) => file.id);
    if (unused.length > 0) forgetDraftFiles(unused);
  } catch {
    // Nothing to sweep without IndexedDB.
  }
}
