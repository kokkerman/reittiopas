// the step by step view of one route: where to walk, which vehicle to take and when

import { mode_color } from "../../styles/mode_colors";
import type { Itinerary, Leg } from "../../types/api_types";
import { LineBadge } from "../../utils/formatting";
import { format_clock_time, format_duration } from "../../utils/time_format";
import { PlaceLink } from "../../map/show_on_map";

const WALK_COLOR = "#737373";
const MIN_SHOWN_WAIT_SECONDS = 30;

interface Point {
  time: number;
  name: string;
  lat: number;
  lon: number;
  code?: string;
  arrived?: number;
}

function stop_code(leg: Leg) {
  return (leg.type === "transit" && leg.from.stopCode) || undefined;
}

function transfer_point(before: Leg, after: Leg): Point {
  const place = after.type === "transit" ? after.from : before.to;
  const waits_here = before.end < after.start - MIN_SHOWN_WAIT_SECONDS;

  return {
    time: after.start,
    name: place.name,
    lat: place.lat,
    lon: place.lon,
    code: stop_code(after),
    arrived: waits_here ? before.end : undefined,
  };
}

function timeline_points(itinerary: Itinerary, from_name: string, to_name: string): Point[] {
  const { legs } = itinerary;
  const first_leg = legs[0];
  const last_place = legs[legs.length - 1].to;

  const points: Point[] = [
    {
      time: first_leg.start,
      name: from_name,
      lat: first_leg.from.lat,
      lon: first_leg.from.lon,
      code: stop_code(first_leg),
    },
  ];

  for (let i = 0; i < legs.length - 1; i++) {
    points.push(transfer_point(legs[i], legs[i + 1]));
  }

  points.push({ time: itinerary.end, name: to_name, lat: last_place.lat, lon: last_place.lon });
  return points;
}

function Segment({ leg }: { leg: Leg }) {
  if (leg.type === "walk") {
    return (
      <div className="flex h-full justify-center">
        <div className="border-l-2 border-dotted" style={{ borderColor: WALK_COLOR }} />
      </div>
    );
  }

  return (
    <div className="relative flex h-full items-center justify-center">
      <div className="absolute inset-y-0 w-1.5 rounded-full" style={{ background: mode_color(leg.mode) }} />
      <span className="relative">
        <LineBadge leg={leg} />
      </span>
    </div>
  );
}

function leg_text(leg: Leg) {
  const duration = format_duration(leg.end - leg.start);
  if (leg.type === "walk") {
    return `Kävely ${leg.distance} m · ${duration}`;
  }

  const stop_count = leg.stops.length - 1;
  const stop_word = stop_count === 1 ? "pysäkki" : "pysäkkiä";
  return `${stop_count} ${stop_word} · ${duration}`;
}

function PointRow({ point, is_endpoint }: { point: Point; is_endpoint: boolean }) {
  return (
    <>
      <span className={`py-0.5 tabular-nums ${is_endpoint ? "font-bold" : "text-neutral-300"}`}>
        {format_clock_time(point.time)}
      </span>
      <div className="flex items-center justify-center">
        <div className={`rounded-full border-2 border-neutral-100 bg-neutral-900 ${is_endpoint ? "size-3" : "size-2.5"}`} />
      </div>
      <div className="min-w-0 truncate py-0.5">
        <PlaceLink point={point} className={is_endpoint ? "font-bold" : ""}>
          {point.name}
        </PlaceLink>
        {point.code && <span className="ml-1.5 text-xs text-neutral-500">{point.code}</span>}
        {point.arrived !== undefined && (
          <div className="text-xs text-neutral-500">
            perillä {format_clock_time(point.arrived)}, odotus {format_duration(point.time - point.arrived)}
          </div>
        )}
      </div>
    </>
  );
}

function LegRow({ leg }: { leg: Leg }) {
  return (
    <>
      <span />
      <div className={leg.type === "walk" ? "min-h-5" : "min-h-9"}>
        <Segment leg={leg} />
      </div>
      <div className="self-center text-xs text-neutral-400">{leg_text(leg)}</div>
    </>
  );
}

interface TimelineProps {
  it: Itinerary;
  fromName: string;
  toName: string;
}

export default function Timeline({ it: itinerary, fromName: from_name, toName: to_name }: TimelineProps) {
  const points = timeline_points(itinerary, from_name, to_name);

  return (
    <div className="grid grid-cols-[2.75rem_3rem_1fr] gap-x-1.5 text-sm">
      {points.map(function (point, i) {
        const leg = itinerary.legs[i] as Leg | undefined;
        const is_endpoint = i === 0 || i === points.length - 1;

        return (
          <div key={i} className="contents">
            <PointRow point={point} is_endpoint={is_endpoint} />
            {leg && <LegRow leg={leg} />}
          </div>
        );
      })}
    </div>
  );
}
