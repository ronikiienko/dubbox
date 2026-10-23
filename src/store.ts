// Where projects live. The browser build keeps them in IndexedDB; a desktop build would swap in a
// folder of .json files behind the same interface. A project is stored as the same JSON text that
// SAVE exports, so moving between backends is just copying text.

export interface ProjectMeta {
  id: string;
  name: string;
  modified: number; // ms since epoch
  tempo: number; // bpm at bar 1
  bars: number; // up to the last note
  map: string[]; // per instrument track, one char per bar: '0'..'3' = how busy (the list's overview)
}

export interface ProjectStore {
  list(): Promise<ProjectMeta[]>;
  read(id: string): Promise<string | undefined>;
  write(meta: ProjectMeta, text: string): Promise<void>;
  rename(meta: ProjectMeta): Promise<void>; // meta only, the song is untouched
  remove(id: string): Promise<void>;
}

/** IndexedDB: metadata and song text in separate stores, so listing doesn't load every song. */
function idbStore(): ProjectStore {
  const db = new Promise<IDBDatabase>((res, rej) => {
    const r = indexedDB.open('dubbox', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('meta', { keyPath: 'id' });
      r.result.createObjectStore('text');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  // ask once for storage the browser won't clear on its own when space runs low
  navigator.storage?.persist?.().catch(() => {});

  async function tx<T>(mode: IDBTransactionMode, fn: (meta: IDBObjectStore, text: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    const t = (await db).transaction(['meta', 'text'], mode);
    const req = fn(t.objectStore('meta'), t.objectStore('text'));
    return new Promise<T>((res, rej) => {
      t.oncomplete = () => res(req ? req.result : (undefined as T));
      t.onerror = t.onabort = () => rej(t.error);
    });
  }

  return {
    list: () => tx('readonly', (m) => m.getAll() as IDBRequest<ProjectMeta[]>),
    read: (id) => tx('readonly', (_, t) => t.get(id) as IDBRequest<string | undefined>),
    write: (meta, text) => tx('readwrite', (m, t) => void (m.put(meta), t.put(text, meta.id))),
    rename: (meta) => tx('readwrite', (m) => void m.put(meta)),
    remove: (id) => tx('readwrite', (m, t) => void (m.delete(id), t.delete(id))),
  };
}

export const store: ProjectStore = idbStore();
