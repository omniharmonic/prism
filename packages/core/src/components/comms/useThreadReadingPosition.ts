import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import {
  loadReadingPosition,
  saveReadingPosition,
  type ThreadReadingIdentity,
  type ThreadReadingPosition,
} from "../../lib/messages/readingPosition";

/** Own absolute event offsets so browser anchoring cannot apply a second correction. */
export function useThreadReadingPosition(
  ref: RefObject<HTMLDivElement | null>,
  messages: Array<{ event_id: string }>,
  identity?: ThreadReadingIdentity,
) {
  const [saved] = useState(() =>
    identity ? loadReadingPosition(identity) : null,
  );
  const pending = useRef(saved);
  const position = useRef<ThreadReadingPosition>({
    eventId: null,
    offset: 0,
    atBottom: true,
  });
  const previous = useRef<{
    first?: string;
    last?: string;
    height: number;
    top: number;
  }>({ height: 0, top: 0 });
  const initialized = useRef(false);
  const programmaticTop = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  const active = useRef(true);
  const [missingPosition, setMissingPosition] = useState(false);
  const [newMessages, setNewMessages] = useState(false);

  function persist() {
    if (identity && initialized.current && !pending.current)
      saveReadingPosition(identity, position.current);
  }
  function schedulePersist() {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (active.current) persist();
    });
  }
  function capture() {
    const container = ref.current;
    if (!container || !container.clientHeight) return;
    const bounds = container.getBoundingClientRect();
    const first = [
      ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find(
      (el) =>
        el.getBoundingClientRect().bottom > bounds.top &&
        el.getBoundingClientRect().top < bounds.bottom,
    );
    position.current = {
      eventId: first?.dataset.messageId || null,
      offset: first ? first.getBoundingClientRect().top - bounds.top : 0,
      atBottom:
        container.scrollHeight - container.scrollTop - container.clientHeight <
        64,
    };
    previous.current.top = container.scrollTop;
    previous.current.height = container.scrollHeight;
  }
  function scrollTo(top: number) {
    const container = ref.current;
    if (!container) return;
    container.scrollTop = top;
    programmaticTop.current = container.scrollTop;
  }
  function apply(target: ThreadReadingPosition): boolean {
    const container = ref.current;
    if (!container) return false;
    if (target.atBottom) {
      scrollTo(container.scrollHeight);
      return true;
    }
    const element = [
      ...container.querySelectorAll<HTMLElement>("[data-message-id]"),
    ].find((el) => el.dataset.messageId === target.eventId);
    if (!element) return false;
    scrollTo(
      container.scrollTop +
        element.getBoundingClientRect().top -
        container.getBoundingClientRect().top -
        target.offset,
    );
    return true;
  }
  function reconcile() {
    const container = ref.current;
    if (!active.current || !container?.clientHeight || !messages.length) return;
    const before = previous.current;
    const first = messages[0]?.event_id,
      last = messages.at(-1)?.event_id;
    if (pending.current) {
      if (apply(pending.current)) {
        pending.current = null;
        setMissingPosition(false);
      } else {
        setMissingPosition(true);
        if (!initialized.current) scrollTo(container.scrollHeight);
      }
    } else if (!initialized.current || position.current.atBottom) {
      scrollTo(container.scrollHeight);
      setNewMessages(false);
    } else {
      const prepended =
        before.first &&
        first !== before.first &&
        messages.some((m) => m.event_id === before.first);
      if (!apply(position.current) && prepended)
        scrollTo(before.top + container.scrollHeight - before.height);
      if (before.last && last !== before.last) setNewMessages(true);
    }
    initialized.current = true;
    previous.current = {
      first,
      last,
      height: container.scrollHeight,
      top: container.scrollTop,
    };
    if (!pending.current) {
      capture();
      schedulePersist();
    }
  }
  function onScroll() {
    const container = ref.current;
    if (!container || !initialized.current) return;
    if (
      programmaticTop.current !== null &&
      Math.abs(container.scrollTop - programmaticTop.current) < 1
    ) {
      programmaticTop.current = null;
      return;
    }
    programmaticTop.current = null;
    pending.current = null;
    setMissingPosition(false);
    capture();
    if (position.current.atBottom) setNewMessages(false);
    schedulePersist();
  }
  function userIntent() {
    // Explicit wheel/touch/navigation supersedes a pending restore even before scrolling.
    pending.current = null;
    setMissingPosition(false);
    programmaticTop.current = null;
    capture();
    schedulePersist();
  }
  function jump() {
    pending.current = null;
    setMissingPosition(false);
    const container = ref.current;
    if (container) scrollTo(container.scrollHeight);
    capture();
    setNewMessages(false);
    schedulePersist();
  }
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      persist();
    };
  }, []);
  useLayoutEffect(() => {
    reconcile();
    const container = ref.current;
    if (!container) return;
    let connected = true;
    const observer = new ResizeObserver(() => {
      if (connected) reconcile();
    });
    observer.observe(container);
    // Message height changes include media/font layout above the visible event.
    container
      .querySelectorAll("[data-message-id]")
      .forEach((el) => observer.observe(el));
    return () => {
      connected = false;
      observer.disconnect();
    };
  }, [messages]);
  return { onScroll, userIntent, jump, newMessages, missingPosition };
}
