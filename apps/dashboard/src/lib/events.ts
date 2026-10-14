import {
  EVENT_PAYLOAD_SCHEMAS,
  parsePersisted,
  type CoreEventType,
  type EventData,
  type VtcEvent,
} from "@vtc/shared";

/**
 * The typed payload of `event` when it is a `type` event, or `null` (another type, or a payload
 * this version cannot read). Tolerant reader (AD-3 rule 2): keys a newer MINOR engine added are
 * dropped, every other rule of the contract still applies. Views read the run's event log through
 * this, so an unknown or malformed event is skipped instead of breaking the page.
 */
export const eventData = <T extends CoreEventType>(
  event: VtcEvent,
  type: T,
): EventData<T> | null => {
  if (event.type !== type) return null;
  const parsed = parsePersisted(EVENT_PAYLOAD_SCHEMAS[type], event.data);
  return parsed.success ? (parsed.data as EventData<T>) : null;
};

/** Every readable `type` event of the log, oldest first, with its envelope. */
export const eventsOfType = <T extends CoreEventType>(
  events: readonly VtcEvent[],
  type: T,
): { readonly event: VtcEvent; readonly data: EventData<T> }[] =>
  events.flatMap((event) => {
    const data = eventData(event, type);
    return data === null ? [] : [{ event, data }];
  });

/** A `ref` that is safe to open as a web link (http/https only), else `null`. */
export const webUrl = (url: string): string | null => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};
