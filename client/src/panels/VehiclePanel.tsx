// the panel for a vehicle or a trip: where its going, if its late and when it gets to the next stops

import { Close } from "../components/icons";
import { useEffect, useState } from "react";
import { api } from "../api/api_client";
import type { TripStop, VehicleTrip } from "../types/api_types";
import { mode_color } from "../styles/mode_colors";
import { ClockTimeWithSchedule, DelayStatus, LineTag } from "../components/transit_badges";
import { format_countdown } from "../utils/time_format";
import { CollapseToggle } from "../components/CollapseToggle";
import { BottomSheet } from "../components/BottomSheet";
import { PlaceLink } from "../map/show_on_map";
import { use_polling_fetch } from "../hooks/use_polling_fetch";

const POLL_MS = 10000;

export type TripSource = { kind: "vehicle"; id: string } | { kind: "trip"; trip_id: string; date: string };

interface Props {
  source: TripSource;
  on_trip: (trip: VehicleTrip | null) => void;
  on_close: () => void;
}

function trip_source_key(source: TripSource): string {
  if (source.kind === "vehicle") {
    return `v:${source.id}`;
  }

  return `t:${source.trip_id}:${source.date}`;
}

function fetch_trip(source: TripSource, signal: AbortSignal): Promise<VehicleTrip> {
  if (source.kind === "vehicle") {
    return api.vehicle_trip(source.id, signal);
  }

  return api.trip(source.trip_id, source.date, signal);
}

export default function VehiclePanel({ source, on_trip, on_close }: Props) {
  const source_key = trip_source_key(source);
  const { data: trip, error, fetched_at: now } = use_polling_fetch(source_key, fetch_source_trip, POLL_MS);
  const [collapsed, set_collapsed] = useState(false);

  useEffect(
    function () {
      set_collapsed(false);
    },
    [source_key],
  );

  // hand the trip to the parent as it arrives (null while loading), and null again on close.
  useEffect(
    function () {
      on_trip(trip);
    },
    [trip, on_trip],
  );

  useEffect(
    function () {
      return function () {
        on_trip(null);
      };
    },
    [on_trip],
  );

  function fetch_source_trip(signal: AbortSignal) {
    return fetch_trip(source, signal);
  }

  function toggle_collapsed() {
    set_collapsed(function (was_collapsed) {
      return !was_collapsed;
    });
  }

  function handle_expanded_change(open: boolean) {
    set_collapsed(!open);
  }

  const upcoming = trip ? trip.stops.slice(trip.nextStopIndex) : [];
  const color = mode_color(trip?.mode);
  const has_arrived = trip !== null && upcoming.length === 0;

  return (
    <BottomSheet
      className="max-h-[50dvh]"
      expanded={!collapsed}
      on_expanded_change={handle_expanded_change}
      on_dismiss={on_close}
      head={
        <header className="flex items-start gap-3 px-3 pt-1 pb-2">
          <TripHeading trip={trip} />
          <CollapseToggle collapsed={collapsed} onToggle={toggle_collapsed} />
          <button onClick={on_close} aria-label="Sulje" className="-mr-1 shrink-0 p-1.5 text-xl text-neutral-400">
            <Close />
          </button>
        </header>
      }
    >
      <div className="border-t border-neutral-800 px-3 py-2">
        {error && <p className="py-1 text-red-400">{error}</p>}
        {has_arrived && <p className="py-1 text-neutral-400">Perillä.</p>}

        {upcoming.length > 0 && (
          <ol>
            {upcoming.map(function (trip_stop, i) {
              return (
                <TripStopRow
                  key={`${trip_stop.id}-${i}`}
                  trip_stop={trip_stop}
                  is_first={i === 0}
                  is_last={i === upcoming.length - 1}
                  color={color}
                  now={now}
                />
              );
            })}
          </ol>
        )}
      </div>
    </BottomSheet>
  );
}

function TripHeading({ trip }: { trip: VehicleTrip | null }) {
  if (!trip) {
    return <p className="flex-1 text-neutral-400">Ladataan…</p>;
  }

  return (
    <>
      <LineTag line={trip.line} mode={trip.mode} large />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg leading-tight font-bold">{trip.headsign}</h2>
        <VehicleStatus trip={trip} />
      </div>
    </>
  );
}

function VehicleStatus({ trip }: { trip: VehicleTrip }) {
  if (trip.vehicle) {
    return <DelayStatus delaySeconds={trip.vehicle.delaySeconds} />;
  }

  return <span className="text-xs text-neutral-400">Ei vielä liikkeellä · aikataulu</span>;
}

interface TripStopRowProps {
  trip_stop: TripStop;
  is_first: boolean;
  is_last: boolean;
  color: string;
  now: number;
}

function TripStopRow({ trip_stop, is_first, is_last, color, now }: TripStopRowProps) {
  return (
    <li className="flex min-h-10 items-stretch gap-3">
      <div className="relative flex w-3 shrink-0 justify-center">
        <div
          className="absolute w-1"
          style={{ background: color, top: is_first ? "50%" : 0, bottom: is_last ? "50%" : 0 }}
        />
        <div
          className={`relative self-center rounded-full border-2 bg-neutral-900 ${is_first ? "size-3" : "size-2.5"}`}
          style={{ borderColor: color }}
        />
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-between gap-2 py-1.5">
        <PlaceLink point={trip_stop} className={is_first ? "font-semibold" : "text-neutral-300"}>
          {trip_stop.name}
        </PlaceLink>
        <div className="shrink-0 text-right">
          <div className={`tabular-nums ${is_first ? "font-semibold" : "text-sm"}`}>
            {format_countdown(trip_stop.estimatedTime, now)}
          </div>
          <ClockTimeWithSchedule
            estimated_time={trip_stop.estimatedTime}
            scheduled_time={trip_stop.scheduledTime}
            realtime={trip_stop.realtime}
          />
        </div>
      </div>
    </li>
  );
}
