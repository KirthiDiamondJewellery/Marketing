"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";

/**
 * Bulk upload of takes from anywhere in Studio: many files at once, two at a time, in 8 MB chunks that resume after
 * a dropped connection (or a reload: drop the same file again and it continues). Each finished file is matched to
 * its script on the server; the Film page shows the match.
 */

export type UploadItem = {
  id: string;
  name: string;
  size: number;
  sent: number;
  status: "queued" | "uploading" | "finishing" | "done" | "error";
  error: string | null;
  contentId: string | null;
  /** "trial": a clean reel (no captions, no title) kept for trial reels instead of going to the editor. */
  purpose: "edit" | "trial";
  result: { uploadId?: string; ref?: string | null; role?: string | null; message?: string; trialAssetId?: string } | null;
  startedAt: number;
};

type Ctx = {
  items: UploadItem[];
  add(files: File[] | FileList, opts?: { contentId?: string | null; purpose?: "edit" | "trial" }): number;
  retry(id: string): void;
  clearDone(): void;
  dismiss(id: string): void;
  active: number;
};

const UploadContext = createContext<Ctx | null>(null);
const CHUNK = 8 * 1024 * 1024;
const PARALLEL = 2;
const VIDEO = /\.(mov|mp4|m4v|webm|mkv)$/i;

export function useUploads(): Ctx {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUploads needs <UploadProvider>");
  return ctx;
}

/** XHR so each chunk reports upload progress (fetch can't). */
function putChunk(url: string, body: Blob, onProgress: (n: number) => void): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(xhr.responseText) as Record<string, unknown>;
      } catch {
        // non-JSON error page
      }
      resolve({ status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.timeout = 10 * 60_000;
    xhr.send(body);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function UploadProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [items, setItems] = useState<UploadItem[]>([]);
  const files = useRef(new Map<string, File>());
  const running = useRef(new Set<string>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const patch = useCallback((id: string, p: Partial<UploadItem>) => setItems((list) => list.map((x) => (x.id === id ? { ...x, ...p } : x))), []);

  const softRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      router.refresh();
    }, 400);
  }, [router]);

  const upload = useCallback(
    async (item: UploadItem) => {
      const file = files.current.get(item.id);
      if (!file) return patch(item.id, { status: "error", error: "The file is no longer available. Drop it again." });
      patch(item.id, { status: "uploading", error: null });
      try {
        const startRes = await fetch("/api/media/upload?step=start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, lastModified: file.lastModified, contentId: item.contentId, purpose: item.purpose }),
        });
        const start = (await startRes.json().catch(() => ({}))) as { ok?: boolean; uploadId?: string; offset?: number; message?: string };
        if (!startRes.ok || !start.uploadId) throw new Error(start.message ?? "The upload couldn't start.");
        let offset = start.offset ?? 0;
        patch(item.id, { sent: offset });
        let failures = 0;
        while (offset < file.size) {
          const end = Math.min(file.size, offset + CHUNK);
          try {
            const base = offset;
            const r = await putChunk(`/api/media/upload?id=${start.uploadId}&offset=${offset}`, file.slice(offset, end), (n) => patch(item.id, { sent: base + n }));
            if (r.status === 409 && typeof r.json.offset === "number") {
              offset = r.json.offset;
              continue;
            }
            if (r.status >= 400) {
              if (typeof r.json.offset === "number") offset = r.json.offset;
              throw new Error(String(r.json.message ?? `The server answered ${r.status}`));
            }
            offset = typeof r.json.offset === "number" ? r.json.offset : end;
            failures = 0;
            patch(item.id, { sent: offset });
          } catch (err) {
            if (++failures > 6) throw err;
            await wait(Math.min(15_000, 800 * 2 ** failures));
            const probe = await fetch(`/api/media/upload?id=${start.uploadId}`).then((x) => x.json()).catch(() => null) as { offset?: number } | null;
            if (typeof probe?.offset === "number") offset = probe.offset;
          }
        }
        patch(item.id, { status: "finishing", sent: file.size });
        const fin = await fetch(`/api/media/upload?step=finish&id=${start.uploadId}`, { method: "POST" });
        const done = (await fin.json().catch(() => ({}))) as { ok?: boolean; message?: string; upload?: { id: string; ref?: string | null; role?: string | null }; trialAssetId?: string };
        if (!fin.ok || !done.ok) throw new Error(done.message ?? "The upload couldn't be finished.");
        patch(item.id, { status: "done", result: { uploadId: done.upload?.id, ref: done.upload?.ref ?? null, role: done.upload?.role ?? null, message: done.message, ...(done.trialAssetId ? { trialAssetId: done.trialAssetId } : {}) } });
        files.current.delete(item.id);
        softRefresh();
      } catch (err) {
        const msg = (err as Error).message;
        patch(item.id, { status: "error", error: msg === "network" || msg === "timeout" ? "The connection dropped. Retry to continue where it stopped." : msg });
      }
    },
    [patch, softRefresh],
  );

  // Two at a time, in the order they were added.
  useEffect(() => {
    const free = PARALLEL - running.current.size;
    if (free <= 0) return;
    const next = items.filter((x) => x.status === "queued" && !running.current.has(x.id)).slice(0, free);
    for (const it of next) {
      running.current.add(it.id);
      void upload(it).finally(() => {
        running.current.delete(it.id);
        setItems((l) => [...l]);
      });
    }
  }, [items, upload]);

  // Leaving mid-upload loses the in-memory file handles: ask first.
  useEffect(() => {
    const busy = items.some((x) => x.status === "uploading" || x.status === "queued" || x.status === "finishing");
    if (!busy) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [items]);

  const add = useCallback((list: File[] | FileList, opts: { contentId?: string | null; purpose?: "edit" | "trial" } = {}) => {
    const accepted = Array.from(list).filter((f) => VIDEO.test(f.name) || f.type.startsWith("video/"));
    if (!accepted.length) return 0;
    const now = Date.now();
    const fresh = accepted.map<UploadItem>((f, i) => {
      const id = `${now}-${i}-${f.name}`;
      files.current.set(id, f);
      return { id, name: f.name, size: f.size, sent: 0, status: "queued", error: null, contentId: opts.contentId ?? null, purpose: opts.purpose ?? "edit", result: null, startedAt: now };
    });
    setItems((l) => [...l, ...fresh]);
    return fresh.length;
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      items,
      add,
      retry: (id) => patch(id, { status: "queued", error: null }),
      clearDone: () => setItems((l) => l.filter((x) => x.status !== "done")),
      dismiss: (id) => {
        files.current.delete(id);
        setItems((l) => l.filter((x) => x.id !== id));
      },
      active: items.filter((x) => x.status === "queued" || x.status === "uploading" || x.status === "finishing").length,
    }),
    [items, add, patch],
  );

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}
