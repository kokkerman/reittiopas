// the panel for a stop. its next departures, delays, and a button to get a route there

import { Close } from "../components/icons";
import { useEffect, useState } from "react";
import { api } from "../api/api_client";
import type { Departure, Stop } from "../types/api_types";
import { ClockTimeWithSchedule, DelayStatus, LineTag } from "../components/transit_badges";
import { format_countdown } from "../utils/time_format";
import { CollapseToggle } from "../components/CollapseToggle";
import { BottomSheet } from "../components/BottomSheet";
import { PlaceLink } from "../map/show_on_map";
import { use_polling_fetch } from "../hooks/use_polling_fetch";

const POLL_MS = 20000;

interface Props {
  stop: Stop;
  on_route_to: (stop: Stop) => void;
  on_open_departure: (departure: Departure) => void;
  on_close: () => void;
}

export default function DeparturesPanel({ stop, on_route_to, on_open_departure, on_close }: Props) {
  const { data, error, fetched_at: now } = use_polling_fetch(stop.id, fetch_departures, POLL_MS);
  const [collapsed, set_collapsed] = useState(false);

  useEffect(
    function () {
      set_collapsed(false);
    },
    [stop.id],
  );

  function fetch_departures(signal: AbortSignal) {
    return api.departures(stop.id, signal);
  }

  function toggle_collapsed() {
    set_collapsed(function (was_collapsed) {
      return !was_collapsed;
    });
  }

  function handle_expanded_change(open: boolean) {
    set_collapsed(!open);
  }

  function route_to_stop() {
    on_route_to(stop);
  }

  const departures = data?.departures ?? [];
  const is_loading = !data && !error;
  const has_no_departures = data !== null && departures.length === 0;

  return (
    <BottomSheet
      className="max-h-[50dvh]"
      expanded={!collapsed}
      on_expanded_change={handle_expanded_change}
      on_dismiss={on_close}
      head={
        <header className="flex items-start gap-2 px-3 pt-1 pb-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-bold">
              <PlaceLink point={stop}>{stop.name}</PlaceLink>
            </h2>
            {stop.code && (
              <span className="mt-0.5 inline-block rounded bg-neutral-800 px-1.5 text-xs text-neutral-400">{stop.code}</span>
            )}
          </div>
          <button
            onClick={route_to_stop}
            className="shrink-0 rounded-full bg-blue-500 px-3 py-1.5 text-sm font-semibold text-white"
          >
            Reitti tänne
          </button>
          <CollapseToggle collapsed={collapsed} onToggle={toggle_collapsed} />
          <button onClick={on_close} aria-label="Sulje" className="-mr-1 shrink-0 p-1.5 text-xl text-neutral-400">
            <Close />
          </button>
        </header>
      }
    >
      <div className="border-t border-neutral-800 px-3 pb-2">
        {error && <p className="py-3 text-red-400">{error}</p>}
        {is_loading && <p className="py-3 text-neutral-400">Ladataan…</p>}
        {has_no_departures && <p className="py-3 text-neutral-400">Ei lähtöjä.</p>}

        {departures.length > 0 && (
          <ul>
            {departures.map(function (departure, i) {
              return (
                <DepartureRow
                  key={`${departure.line}-${departure.scheduledTime}-${i}`}
                  departure={departure}
                  now={now}
                  on_open={on_open_departure}
                />
              );
            })}
          </ul>
        )}
      </div>
    </BottomSheet>
  );
}

interface DepartureRowProps {
  departure: Departure;
  now: number;
  on_open: (departure: Departure) => void;
}

function DepartureRow({ departure, now, on_open }: DepartureRowProps) {
  function open_departure() {
    on_open(departure);
  }

  return (
    <li className="border-b border-neutral-800/70 last:border-0">
      <button
        type="button"
        onClick={open_departure}
        disabled={!departure.tripId}
        className="flex w-full items-center gap-3 py-2.5 text-left"
      >
        <LineTag line={departure.line} mode={departure.mode} />
        <div className="min-w-0 flex-1">
          <div className="truncate">{departure.headsign}</div>
          <DelayStatus
            delaySeconds={departure.delaySeconds}
            realtime={departure.realtime}
            cancelled={departure.cancelled}
          />
        </div>
        <div className="shrink-0 text-right">
          <div className={`font-semibold tabular-nums ${departure.cancelled ? "text-neutral-500 line-through" : ""}`}>
            {format_countdown(departure.estimatedTime, now)}
          </div>
          <ClockTimeWithSchedule
            estimated_time={departure.estimatedTime}
            scheduled_time={departure.scheduledTime}
            realtime={departure.realtime}
          />
        </div>
      </button>
    </li>
  );
}
