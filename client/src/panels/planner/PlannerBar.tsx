// the bottom panel of the planner: the selected route, its departure times and the step by step timeline

import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "../../components/icons";
import { itinerary_color } from "../../styles/itinerary_colors";
import { format_clock_time, format_duration } from "../../utils/time_format";
import Timeline from "./Timeline";
import type { Itinerary } from "../../types/api_types";
import type { Planner } from "../../hooks/use_planner";
import { route_key, use_planner_groups } from "../../hooks/use_route_groups";
import { BottomSheet } from "../../components/BottomSheet";

function time_range(itinerary: Itinerary): string {
  return `${format_clock_time(itinerary.start)} – ${format_clock_time(itinerary.end)}`;
}

function transfers_text(transfers: number): string {
  if (transfers === 0) {
    return "";
  }

  const plural_suffix = transfers > 1 ? "a" : "";
  return ` · ${transfers} vaihto${plural_suffix}`;
}

function has_transit(itinerary: Itinerary): boolean {
  return itinerary.legs.some(function (leg) {
    return leg.type === "transit";
  });
}

interface DepartureChipProps {
  itinerary: Itinerary;
  active: boolean;
  on_select: () => void;
}

function DepartureChip({ itinerary, active, on_select }: DepartureChipProps) {
  const state_classes = active ? "bg-neutral-100 font-semibold text-neutral-900" : "bg-neutral-800 text-neutral-300";

  return (
    <button
      onClick={on_select}
      aria-pressed={active}
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-sm whitespace-nowrap tabular-nums transition-colors ${state_classes}`}
    >
      {time_range(itinerary)}
    </button>
  );
}

function LoadMoreLabel({ loading, earlier }: { loading: boolean; earlier: boolean }) {
  if (loading) {
    return "Haetaan…";
  }

  if (earlier) {
    return (
      <>
        Aiemmat
        <ChevronLeft />
      </>
    );
  }

  return (
    <>
      Myöhemmät
      <ChevronRight />
    </>
  );
}

export default function PlannerBar({ planner }: { planner: Planner }) {
  const { itineraries, loading, error, from, to, notice } = planner;
  const [open, set_open] = useState(false);
  const { groups, focused, focused_group } = use_planner_groups(planner);
  const itinerary = focused !== null ? itineraries?.[focused] : undefined;
  const departures = focused_group !== null ? groups[focused_group].options : [];

  useEffect(
    function () {
      if (loading) {
        set_open(false);
      }
    },
    [loading],
  );

  if (!from || !to) return null;

  const route_count = groups.length;
  const has_alternatives = route_count > 1;

  function step_route(direction: number) {
    if (focused_group === null) return;

    const next_group = (focused_group + direction + route_count) % route_count;
    planner.select(groups[next_group].options[0]);
  }

  function show_previous_route() {
    step_route(-1);
  }

  function show_next_route() {
    step_route(1);
  }

  function toggle_open() {
    set_open(function (was_open) {
      return !was_open;
    });
  }

  function load_more() {
    if (focused !== null) {
      planner.load_more(focused);
    }
  }

  const can_load_more = itinerary !== undefined && (planner.arrive_limit || has_transit(itinerary));
  const notice_is_for_this_route = itinerary !== undefined && notice?.route === route_key(itinerary);
  const notice_applies = itinerary !== undefined && (planner.arrive_limit || notice_is_for_this_route);
  const show_notice = notice !== null && notice_applies;

  const head = (
    <div className="px-2 pt-0.5 pb-2">
      {loading && <p className="text-neutral-400">Haetaan reittejä…</p>}
      {error && <p className="text-red-400">{error}</p>}
      {itineraries && route_count === 0 && <p className="text-neutral-400">Reittejä ei löytynyt.</p>}

      {itinerary && (
        <div className="flex items-center gap-1">
          {has_alternatives && (
            <button onClick={show_previous_route} aria-label="Edellinen reitti" className="-ml-1 p-2 text-xl">
              <ChevronLeft />
            </button>
          )}
          <button
            onClick={toggle_open}
            aria-expanded={open}
            className="min-w-0 flex-1 border-l-4 pl-3 text-left"
            style={{ borderColor: itinerary_color(focused_group ?? 0) }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold">{time_range(itinerary)}</span>
              <span className="flex items-center gap-1">
                {format_duration(itinerary.duration)}
                {open ? <ChevronDown /> : <ChevronUp />}
              </span>
            </div>
            <div className="truncate text-sm text-neutral-400">
              kävelyä {itinerary.walkDistance} m{transfers_text(itinerary.transfers)}
              {has_alternatives && ` · reitti ${focused_group! + 1}/${route_count}`}
            </div>
          </button>
          {has_alternatives && (
            <button onClick={show_next_route} aria-label="Seuraava reitti" className="-mr-1 p-2 text-xl">
              <ChevronRight />
            </button>
          )}
        </div>
      )}

      {itinerary && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="shrink-0 pl-1 text-xs text-neutral-500">Lähdöt</span>
          <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
            {departures.map(function (option_index) {
              return (
                <DepartureChip
                  key={option_index}
                  itinerary={itineraries![option_index]}
                  active={option_index === focused}
                  on_select={function () {
                    planner.select(option_index);
                  }}
                />
              );
            })}
            {can_load_more && (
              <button
                onClick={load_more}
                disabled={planner.loading_more}
                className="flex shrink-0 items-center gap-0.5 rounded-full border border-neutral-700 px-2.5 py-0.5 text-sm whitespace-nowrap text-neutral-300 disabled:opacity-50"
              >
                <LoadMoreLabel loading={planner.loading_more} earlier={planner.arrive_limit} />
              </button>
            )}
          </div>
        </div>
      )}
      {show_notice && <p className="mt-1 pl-1 text-xs text-neutral-400">{notice.text}</p>}
    </div>
  );

  return (
    <BottomSheet
      className="max-h-[55dvh]"
      expanded={open && !!itinerary}
      on_expanded_change={set_open}
      head={head}
    >
      {itinerary && (
        <div className="border-t border-neutral-800 px-3 py-2">
          <Timeline it={itinerary} fromName={from.name} toName={to.name} />
        </div>
      )}
    </BottomSheet>
  );
}
