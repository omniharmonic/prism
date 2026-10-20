/**
 * React Query hooks over the notifications client (wave 2A).
 *
 * The unread count is the cheap call every surface shares (sidebar badge, phone
 * badge, Home). It doubles as the AVAILABILITY probe: a 401/403/404/501 or a
 * network failure (desktop shell with no Prism Server, older server) means the
 * feature is hidden — never an error banner in the sidebar.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import {
  notificationsApi,
  NotificationsError,
  type NotificationItem,
  type NotificationPage,
  type NotificationSettings,
  type NotificationType,
  type PageNotificationLevel,
} from "./client";

export const notificationKeys = {
  all: ["notifications"] as const,
  unread: ["notifications", "unread"] as const,
  list: (box: "inbox" | "archived", type?: NotificationType) => ["notifications", "list", box, type ?? "all"] as const,
  settings: ["notifications", "settings"] as const,
  pageLevel: (noteId: string) => ["notifications", "page-level", noteId] as const,
  reminders: ["notifications", "reminders"] as const,
  accessRequests: ["notifications", "access-requests"] as const,
};

/** Statuses that mean "this server has no notifications for you", not "broken". */
const UNAVAILABLE = new Set([401, 403, 404, 405, 501]);
export function isNotificationsUnavailable(error: unknown): boolean {
  if (error instanceof NotificationsError) return UNAVAILABLE.has(error.status);
  return error instanceof TypeError; // fetch could not reach a server at all
}

/** Poll cadence for the badge; also refetched on focus and on `prism:notifications-changed`. */
export const UNREAD_POLL_MS = 60_000;

function useNotificationsChangedRefetch(refetch: () => void) {
  useEffect(() => {
    const h = () => refetch();
    window.addEventListener("prism:notifications-changed", h);
    return () => window.removeEventListener("prism:notifications-changed", h);
  }, [refetch]);
}

/** Announce a local change (read/archive) so every list and badge refetches. */
export function announceNotificationsChanged(): void {
  window.dispatchEvent(new Event("prism:notifications-changed"));
}

export function useUnreadCount(): { count: number; available: boolean; loading: boolean } {
  const q = useQuery({
    queryKey: notificationKeys.unread,
    queryFn: () => notificationsApi.unread(),
    refetchInterval: (query) => (query.state.error && isNotificationsUnavailable(query.state.error) ? false : UNREAD_POLL_MS),
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 10_000,
  });
  useNotificationsChangedRefetch(q.refetch);
  const unavailable = !!q.error && isNotificationsUnavailable(q.error);
  return { count: q.data?.unread ?? 0, available: q.isSuccess || (!!q.error && !unavailable), loading: q.isLoading };
}

export function useNotifications(box: "inbox" | "archived", type?: NotificationType) {
  const q = useInfiniteQuery({
    queryKey: notificationKeys.list(box, type),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => notificationsApi.list({ box, type, limit: 50, before: pageParam }),
    getNextPageParam: (page) => page.next,
    retry: false,
    refetchOnWindowFocus: true,
  });
  useNotificationsChangedRefetch(q.refetch);
  return q;
}

type ListData = InfiniteData<NotificationPage, string | null>;

/** Apply a local patch to every cached notification list (optimistic read/archive). */
function patchLists(qc: ReturnType<typeof useQueryClient>, fn: (item: NotificationItem) => NotificationItem | null) {
  const snapshots = qc.getQueriesData<ListData>({ queryKey: ["notifications", "list"] });
  for (const [key, data] of snapshots) {
    if (!data) continue;
    qc.setQueryData<ListData>(key, {
      ...data,
      pages: data.pages.map((p) => ({ ...p, items: p.items.map(fn).filter((x): x is NotificationItem => !!x) })),
    });
  }
  return snapshots;
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: { ids?: string[]; all?: boolean }) => notificationsApi.markRead(o),
    onMutate: async (o) => {
      await qc.cancelQueries({ queryKey: ["notifications"] });
      const now = Date.now();
      const ids = new Set(o.ids ?? []);
      const lists = patchLists(qc, (it) => (it.readAt || !(o.all || ids.has(it.id)) ? it : { ...it, readAt: now }));
      const unread = qc.getQueryData<{ unread: number }>(notificationKeys.unread);
      if (unread) qc.setQueryData(notificationKeys.unread, { unread: o.all ? 0 : Math.max(0, unread.unread - ids.size) });
      return { lists, unread };
    },
    onError: (_e, _o, ctx) => {
      for (const [k, d] of ctx?.lists ?? []) qc.setQueryData(k, d);
      if (ctx?.unread) qc.setQueryData(notificationKeys.unread, ctx.unread);
    },
    onSuccess: (r) => qc.setQueryData(notificationKeys.unread, { unread: r.unread }),
  });
}

export function useArchive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (o: { ids: string[]; archived: boolean }) => notificationsApi.archive(o.ids, o.archived),
    onMutate: async (o) => {
      await qc.cancelQueries({ queryKey: ["notifications", "list"] });
      const ids = new Set(o.ids);
      const lists = patchLists(qc, (it) => (ids.has(it.id) ? null : it));
      return { lists };
    },
    onError: (_e, _o, ctx) => {
      for (const [k, d] of ctx?.lists ?? []) qc.setQueryData(k, d);
    },
    onSettled: (r) => {
      if (r) qc.setQueryData(notificationKeys.unread, { unread: r.unread });
      void qc.invalidateQueries({ queryKey: ["notifications", "list"] });
    },
  });
}

export function useNotificationSettings() {
  return useQuery({ queryKey: notificationKeys.settings, queryFn: () => notificationsApi.getSettings(), retry: false });
}

export function useSaveNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: NotificationSettings) => notificationsApi.putSettings(s),
    onSuccess: (r) => qc.setQueryData(notificationKeys.settings, r),
  });
}

/**
 * Your notification level for one page (NP-CO-04). `available` is false while
 * unknown and wherever the server has no such thing for this viewer — a share-link
 * guest (401), an older server (404), the desktop shell — so the control hides.
 */
export function usePageNotificationLevel(noteId: string | null, enabled = true) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: notificationKeys.pageLevel(noteId ?? ""),
    queryFn: () => notificationsApi.getPageLevel(noteId!),
    enabled: enabled && !!noteId,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const save = useMutation({
    mutationFn: (level: PageNotificationLevel) => notificationsApi.setPageLevel(noteId!, level),
    onSuccess: (r) => qc.setQueryData(notificationKeys.pageLevel(noteId ?? ""), r),
  });
  const level = q.data?.level === "all" || q.data?.level === "mentions" || q.data?.level === "none" ? q.data.level : null;
  return { level, available: q.isSuccess && level !== null, set: save.mutate, saving: save.isPending, failed: save.isError };
}

export function useReminders() {
  return useQuery({ queryKey: notificationKeys.reminders, queryFn: () => notificationsApi.listReminders(), retry: false, staleTime: 30_000 });
}

export function useAccessRequests(enabled = true) {
  return useQuery({ queryKey: notificationKeys.accessRequests, queryFn: () => notificationsApi.listAccessRequests(), retry: false, enabled });
}

/** Browser online state (offline banner). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}
