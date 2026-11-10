// a hook for fetching something and refreshing it every few seconds, cancelling old requests


import { useEffect, useRef, useState } from "react";
import { error_message, is_abort_error } from "../utils/errors";

interface PollingResult<T> {
  data: T | null;
  error: string | null;
  fetched_at: number;
}

export function use_polling_fetch<T>(
  key: string,
  fetch_data: (signal: AbortSignal) => Promise<T>,
  interval_ms: number,
): PollingResult<T> {
  const [data, set_data] = useState<T | null>(null);
  const [error, set_error] = useState<string | null>(null);
  const [fetched_at, set_fetched_at] = useState(Date.now());

  const latest_fetch_data = useRef(fetch_data);
  latest_fetch_data.current = fetch_data;

  useEffect(function start_polling() {
    set_data(null);
    set_error(null);

    let controller = new AbortController();

    async function load() {
      controller.abort();
      controller = new AbortController();

      try {
        const result = await latest_fetch_data.current(controller.signal);

        set_data(result);
        set_error(null);
        set_fetched_at(Date.now());
      } catch (caught_error) {
        if (!is_abort_error(caught_error)) {
          set_error(error_message(caught_error));
        }
      }
    }

    load();
    const timer = setInterval(load, interval_ms);

    return function stop_polling() {
      clearInterval(timer);
      controller.abort();
    };
  }, [key, interval_ms]);

  return { data, error, fetched_at };
}
