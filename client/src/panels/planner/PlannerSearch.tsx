// the top panel of the planner: from, to, the time and the search button. shrinks to a summary after a search

import { useEffect, useState } from "react";
import { ChevronUp, Close, Swap } from "../../components/icons";
import { format_clock_time } from "../../utils/time_format";
import PlaceInput from "./PlaceInput";
import TimePicker, { type TimeTab } from "./TimePicker";
import { TopSheet } from "../../components/TopSheet";
import type { Planner, PlannerPlace } from "../../hooks/use_planner";

interface Props {
  planner: Planner;
  focus: { lat: number; lon: number } | null;
  on_close: () => void;
  my_location: { lat: number; lon: number } | null;
}

function departure_text(time: number | null): string {
  if (time === null) {
    return "Lähtö nyt";
  }

  return `Lähtö ${format_clock_time(time)}`;
}

function SearchSummary({ planner, on_close }: { planner: Planner; on_close: () => void }) {
  const { from, to, time, arrive_limit, arrive_time } = planner;
  if (!from || !to) return null;

  const deadline = arrive_time ?? Math.floor(Date.now() / 1000);

  function start_editing() {
    planner.set_editing(true);
  }

  return (
    <div className="flex items-center gap-2">
      <button onClick={start_editing} className="min-w-0 flex-1 text-left">
        <div className="truncate">
          {from.name} – {to.name}
        </div>
        <div className="text-sm text-neutral-400">
          {departure_text(time)}
          {arrive_limit && ` · perillä viimeistään ${format_clock_time(deadline)}`}
        </div>
      </button>
      <button onClick={on_close} aria-label="Sulje reittihaku" className="-m-1 p-2 text-xl">
        <Close />
      </button>
    </div>
  );
}

export default function PlannerSearch({ planner, focus, on_close, my_location }: Props) {
  const { from, to, itineraries, time, editing, loading, set_editing } = planner;
  const [time_tab, set_time_tab] = useState<TimeTab>("depart");

  useEffect(
    function () {
      if (!loading && itineraries) {
        set_editing(false);
      }
    },
    [loading],
  );

  const can_collapse = !!(from && to);
  const autofocus_destination = !to && window.matchMedia("(pointer: fine)").matches;

  function stop_editing() {
    set_editing(false);
  }

  function activate_from() {
    planner.set_active("from");
  }

  function activate_to() {
    planner.set_active("to");
  }

  function change_from(place: PlannerPlace | null) {
    planner.set_place("from", place);
  }

  function change_to(place: PlannerPlace | null) {
    planner.set_place("to", place);
  }

  return (
    <TopSheet
      expanded={editing || !can_collapse}
      can_collapse={can_collapse}
      on_expanded_change={set_editing}
      summary={<SearchSummary planner={planner} on_close={on_close} />}
    >
      <div className="flex flex-col gap-2 pb-1">
        <div className="flex items-center justify-between">
          <h2 className="font-bold">Reittihaku</h2>
          <div className="-m-1 flex">
            {can_collapse && (
              <button onClick={stop_editing} aria-label="Pienennä" className="p-2 text-xl">
                <ChevronUp />
              </button>
            )}
            <button onClick={on_close} aria-label="Sulje reittihaku" className="p-2 text-xl">
              <Close />
            </button>
          </div>
        </div>

        <div className="relative rounded-xl bg-neutral-800">
          <PlaceInput
            label="Mistä"
            value={from}
            active={planner.active === "from"}
            focus={focus}
            on_activate={activate_from}
            on_change={change_from}
            my_location={my_location}
          />
          <div className="ml-16 border-t border-neutral-700" />
          <PlaceInput
            label="Minne"
            auto_focus={autofocus_destination}
            value={to}
            active={planner.active === "to"}
            focus={focus}
            on_activate={activate_to}
            on_change={change_to}
            my_location={my_location}
          />
          <button
            onClick={planner.swap}
            aria-label="Vaihda suunta"
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full border border-neutral-700 bg-neutral-900 p-2 text-neutral-300"
          >
            <Swap />
          </button>
        </div>

        <TimePicker
          tab={time_tab}
          onTab={set_time_tab}
          departTime={time}
          onDepart={planner.set_time}
          arriveTime={planner.arrive_time}
          onArrive={planner.set_arrive_time}
          arriveLimit={planner.arrive_limit}
          onArriveLimit={planner.set_arrive_limit}
        />

        <button
          type="button"
          onClick={planner.search}
          disabled={!from || !to || loading}
          className="h-11 rounded-xl bg-blue-500 font-semibold text-white transition-opacity disabled:opacity-40"
        >
          {loading ? "Haetaan…" : "Hae"}
        </button>
      </div>
    </TopSheet>
  );
}
