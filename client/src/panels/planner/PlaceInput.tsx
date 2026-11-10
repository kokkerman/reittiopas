// a text field for a place with search suggestions, used for the from and to fields on the top panel

import { useEffect, useState, type ChangeEvent, type MouseEvent } from "react";
import { api } from "../../api/api_client";
import type { PlaceSuggestion } from "../../types/api_types";
import type { PlannerPlace } from "../../hooks/use_planner";

const DEBOUNCE_MS = 250;

interface Props {
  label: string;
  value: PlannerPlace | null;
  active: boolean;
  focus: { lat: number; lon: number } | null;
  on_activate: () => void;
  on_change: (place: PlannerPlace | null) => void;
  my_location: { lat: number; lon: number } | null;
  auto_focus?: boolean;
}

function keep_input_focus(event: MouseEvent) {
  event.preventDefault();
}

export default function PlaceInput(props: Props) {
  const { label, value, active, focus, on_activate, on_change, my_location, auto_focus } = props;
  const [text, set_text] = useState(value?.name ?? "");
  const [suggestions, set_suggestions] = useState<PlaceSuggestion[]>([]);
  const [open, set_open] = useState(false);

  useEffect(
    function () {
      set_text(value?.name ?? "");
    },
    [value],
  );

  useEffect(
    function () {
      const too_short = text.trim().length < 2;
      const is_chosen_place = text === value?.name;

      if (!open || too_short || is_chosen_place) {
        set_suggestions([]);
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(function () {
        api
          .places(text, focus, controller.signal)
          .then(set_suggestions)
          .catch(function () {

          });
      }, DEBOUNCE_MS);

      return function () {
        clearTimeout(timer);
        controller.abort();
      };
    },

    [text, open, value],
  );

  function choose(suggestion: PlaceSuggestion) {
    on_change({ name: suggestion.name, lat: suggestion.lat, lon: suggestion.lon });
    set_open(false);
    set_suggestions([]);
  }

  function choose_my_location() {
    if (!my_location) return;

    on_change({ name: "Oma sijainti", lat: my_location.lat, lon: my_location.lon });
    set_open(false);
  }

  function handle_focus() {
    on_activate();
    set_open(true);
  }

  function handle_blur() {
    // let a suggestion tap land first.
    setTimeout(function () {
      set_open(false);
    }, 150);
  }

  function handle_text_change(event: ChangeEvent<HTMLInputElement>) {
    set_text(event.target.value);
    if (!event.target.value) {
      on_change(null);
    }
  }

  const show_my_location = open && my_location !== null && text.trim() === "";
  const show_suggestions = open && suggestions.length > 0;

  return (
    <div className="relative">
      <label className="flex h-11 items-center">
        <span className={`w-16 shrink-0 pl-3 text-sm ${active ? "text-blue-400" : "text-neutral-400"}`}>{label}</span>
        <input
          type="search"
          autoFocus={auto_focus}
          value={text}
          placeholder={active ? "Hae tai napauta karttaa" : "Hae paikkaa"}
          onFocus={handle_focus}
          onBlur={handle_blur}
          onChange={handle_text_change}
          className="h-full min-w-0 flex-1 bg-transparent pr-12 outline-none placeholder:text-neutral-500"
        />
      </label>

      {show_my_location && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-neutral-700/60 bg-neutral-800 shadow-lg shadow-black/50">
          <li>
            <button
              type="button"
              onMouseDown={keep_input_focus}
              onClick={choose_my_location}
              className="w-full px-3 py-2 text-left text-blue-400"
            >
              Oma sijainti
            </button>
          </li>
        </ul>
      )}

      {show_suggestions && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-neutral-700/60 bg-neutral-800 shadow-lg shadow-black/50">
          {suggestions.map(function (suggestion, i) {
            return (
              <li key={`${suggestion.label}-${i}`}>
                <button
                  type="button"
                  onMouseDown={keep_input_focus}
                  onClick={function () {
                    choose(suggestion);
                  }}
                  className="w-full px-3 py-2 text-left"
                >
                  <div>{suggestion.name}</div>
                  <div className="truncate text-sm text-neutral-400">{suggestion.label}</div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
