// the main app

import { useCallback, useEffect, useRef, useState } from "react";
import MapGL, {
  type MapEvent,
  type MapLayerMouseEvent,
  type MapRef,
  type ViewStateChangeEvent,
} from "react-map-gl/maplibre";
import type { Map as MapLibreMap } from "maplibre-gl";
import { api } from "./api/api_client";
import StopsLayer, { STOPS_HIT_LAYER } from "./map/StopsLayer";
import DeparturesPanel from "./panels/DeparturesPanel";
import VehiclesLayer, { VEHICLES_HIT_LAYER } from "./map/VehiclesLayer";
import VehiclePanel, { type TripSource } from "./panels/VehiclePanel";
import TripLayer from "./map/TripLayer";
import PlannerSearch from "./panels/planner/PlannerSearch";
import PlannerBar from "./panels/planner/PlannerBar";
import PlannerLayer, { PLANNER_HIT_LAYER } from "./map/PlannerLayer";
import { use_planner, type PlannerPlace } from "./hooks/use_planner";
import type { Departure, Stop, VehicleTrip } from "./types/api_types";
import { use_location, type LocationStatus } from "./hooks/use_location";
import LocationLayer from "./map/LocationLayer";
import { HighlightMarker, ShowOnMapContext, type MapPoint } from "./map/show_on_map";
import { Locate, Search } from "./components/icons";
import { PANEL_SURFACE, TOP_PANEL, TOP_PANEL_MOTION } from "./styles/panel_styles";
import { AnimatePresence, motion } from "motion/react";
import { error_message, is_abort_error } from "./utils/errors";

const MY_LOCATION = "Oma sijainti";
const HIGHLIGHT_MS = 4000;

const MAP_STYLE = "https://tiles.openfreemap.org/styles/dark";

const HELSINKI = { latitude: 60.1699, longitude: 24.9384, zoom: 15 };

function simplify_style(map: MapLibreMap) {
  for (const layer of map.getStyle().layers) {
    if ("source-layer" in layer && layer["source-layer"] === "poi") {
      map.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

const LOCATION_HINTS: Record<string, string> = {
  off: "Näytä oma sijainti",
  locating: "Haetaan sijaintia…",
  on: "Oma sijainti",
  denied: "Sijainnin käyttö on estetty. Salli se selaimen asetuksista.",
  insecure: "Sijainti toimii vain HTTPS-yhteydellä (tai localhostissa).",
  unavailable: "Sijaintia ei saatu, yritetään edelleen.",
};

const LOCATION_PROBLEM_STATUSES = ["insecure", "denied", "unavailable"];

type Selection = { kind: "stop"; stop: Stop } | TripSource | null;

function is_trip_selection(selected: Selection): selected is TripSource {
  return selected?.kind === "vehicle" || selected?.kind === "trip";
}

function selected_vehicle_id(selected: Selection, trip: VehicleTrip | null): string | null {
  if (selected?.kind === "vehicle") {
    return selected.id;
  }

  if (selected?.kind === "trip") {
    return trip?.vehicle?.id ?? null;
  }

  return null;
}

function locate_button_tone(status: LocationStatus): string {
  if (status === "on") {
    return "text-blue-400";
  }

  if (status === "locating") {
    return "animate-pulse";
  }

  return "";
}

function stop_place(stop: Stop): PlannerPlace {
  return { name: stop.name, lat: stop.lat, lon: stop.lon };
}

function find_stop(stops: Stop[], id: string | undefined): Stop | undefined {
  if (!id) {
    return undefined;
  }

  return stops.find(function (stop) {
    return stop.id === id;
  });
}

function find_feature(event: MapLayerMouseEvent, layer_id: string) {
  return event.features?.find(function (feature) {
    return feature.layer.id === layer_id;
  });
}

// the tapped stop if there is one, otherwise the tapped point itself.
function clicked_place(event: MapLayerMouseEvent, stops: Stop[]): PlannerPlace {
  const stop_feature = find_feature(event, STOPS_HIT_LAYER);
  const stop = find_stop(stops, stop_feature?.properties?.id as string | undefined);
  if (stop) {
    return stop_place(stop);
  }

  return { name: "Kartalta valittu paikka", lat: event.lngLat.lat, lon: event.lngLat.lng };
}

function use_expiring_state<T>(empty_value: T) {
  const [value, set_value] = useState<T>(empty_value);

  useEffect(function () {
    if (!value) return;
    const timer = setTimeout(function () {
      set_value(empty_value);
    }, HIGHLIGHT_MS);
    return function () {
      clearTimeout(timer);
    };
  }, [value, empty_value]);

  return [value, set_value] as const;
}

function use_map_busy() {
  const [map_busy, set_map_busy] = useState(false);
  const pressing = useRef(false);

  useEffect(function () {
    function release(event: MouseEvent | TouchEvent) {
      const fingers_still_down = "touches" in event && event.touches.length > 0;
      if (fingers_still_down) return;
      pressing.current = false;
      set_map_busy(false);
    }

    window.addEventListener("mouseup", release);
    window.addEventListener("touchend", release);
    window.addEventListener("touchcancel", release);
    return function () {
      window.removeEventListener("mouseup", release);
      window.removeEventListener("touchend", release);
      window.removeEventListener("touchcancel", release);
    };
  }, []);

  return { map_busy, set_map_busy, pressing };
}

function use_stops() {
  const [stops, set_stops] = useState<Stop[]>([]);
  const [error, set_error] = useState<string | null>(null);

  useEffect(function () {
    const controller = new AbortController();
    api
      .stops(controller.signal)
      .then(set_stops)
      .catch(function (caught_error: unknown) {
        if (is_abort_error(caught_error)) return;
        set_error(error_message(caught_error));
      });
    return function () {
      controller.abort();
    };
  }, []);

  return { stops, error };
}

export default function App() {
  const { stops, error } = use_stops();
  const [selected, set_selected] = useState<Selection>(null);
  const [trip, set_trip] = useState<VehicleTrip | null>(null);
  const [planning, set_planning] = useState(false);
  const [center, set_center] = useState({ lat: HELSINKI.latitude, lon: HELSINKI.longitude });
  const planner = use_planner();
  const { active: planner_field, editing: planner_editing, set_place, select: select_itinerary } = planner;
  const map_ref = useRef<MapRef>(null);
  const { map_busy, set_map_busy, pressing } = use_map_busy();
  const location = use_location();
  const [highlight, set_highlight] = use_expiring_state<MapPoint | null>(null);

  const show_on_map = useCallback(
    function (point: MapPoint) {
      const map = map_ref.current;
      if (!map) return;
      map.flyTo({
        center: [point.lon, point.lat],
        zoom: Math.max(map.getZoom(), 16),
        offset: [0, -map.getContainer().clientHeight * 0.2],
        duration: 600,
      });
      set_highlight(point);
    },
    [set_highlight],
  );

  const auto_from = useRef(false);
  useEffect(function () {
    const position = location.position;
    const should_fill_from = planning && !auto_from.current && !planner.from && position;
    if (!should_fill_from) return;
    auto_from.current = true;
    set_place("from", { name: MY_LOCATION, lat: position.lat, lon: position.lon });
  }, [planning, planner.from, location.position, set_place]);

  function locate() {
    location.start();
    if (location.position) {
      show_on_map(location.position);
    }
  }
  const waiting_for_fix = useRef(false);
  const [locate_hint, set_locate_hint] = use_expiring_state(false);
  useEffect(function () {
    if (waiting_for_fix.current && location.position) {
      waiting_for_fix.current = false;
      show_on_map(location.position);
    }
  }, [location.position, show_on_map]);

  const handle_click = useCallback(
    function (event: MapLayerMouseEvent) {
      if (planning) {
        const route = find_feature(event, PLANNER_HIT_LAYER);
        if (route) {
          select_itinerary(route.properties.option as number);
          return;
        }
        if (!planner_editing) return;
        set_place(planner_field, clicked_place(event, stops));
        return;
      }

      const feature = event.features?.[0];
      const id = feature?.properties?.id as string | undefined;
      const vehicle_id = feature?.layer.id === VEHICLES_HIT_LAYER ? id : undefined;

      let center: [number, number];
      if (vehicle_id) {
        set_selected({ kind: "vehicle", id: vehicle_id });
        center = [event.lngLat.lng, event.lngLat.lat];
      } else {
        const stop = find_stop(stops, id);
        if (!stop) {
          set_selected(null);
          return;
        }
        set_selected({ kind: "stop", stop });
        center = [stop.lon, stop.lat];
      }

      const map = event.target;
      map.easeTo({ center, offset: [0, -map.getContainer().clientHeight * 0.25], duration: 300 });
    },
    [stops, planning, planner_field, planner_editing, set_place, select_itinerary],
  );

  function open_departure(departure: Departure) {
    if (departure.vehicleId) {
      set_selected({ kind: "vehicle", id: departure.vehicleId });
    } else if (departure.tripId && departure.serviceDate) {
      set_selected({ kind: "trip", trip_id: departure.tripId, date: departure.serviceDate });
    }
  }

  function open_planner() {
    set_selected(null);
    set_planning(true);
    location.start();
  }

  function close_planner() {
    planner.reset();
    auto_from.current = false;
    set_planning(false);
  }

  function route_to(stop: Stop) {
    open_planner();
    set_place("to", stop_place(stop));
  }

  function close_selection() {
    set_selected(null);
  }

  function handle_map_load(event: MapEvent) {
    simplify_style(event.target);
  }

  function handle_press_start() {
    pressing.current = true;
  }

  function handle_move_start(event: ViewStateChangeEvent) {
    if (event.originalEvent) {
      set_map_busy(true);
    }
  }

  function handle_move_end(event: ViewStateChangeEvent) {
    set_center({ lat: event.viewState.latitude, lon: event.viewState.longitude });
    if (!pressing.current) {
      set_map_busy(false);
    }
  }

  function handle_locate_click() {
    waiting_for_fix.current = !location.position;
    set_locate_hint(true);
    locate();
  }
  const show_location_problem = locate_hint && LOCATION_PROBLEM_STATUSES.includes(location.status);
  const has_planner_results = Boolean(planner.loading || planner.error || planner.itineraries);

  return (
    <ShowOnMapContext.Provider value={show_on_map}>
      <div className="relative h-dvh w-full overflow-hidden" data-map-busy={map_busy}>
        <MapGL
          ref={map_ref}
          initialViewState={HELSINKI}
          mapStyle={MAP_STYLE}
          interactiveLayerIds={[VEHICLES_HIT_LAYER, PLANNER_HIT_LAYER, STOPS_HIT_LAYER]}
          onClick={handle_click}
          onLoad={handle_map_load}
          onMouseDown={handle_press_start}
          onTouchStart={handle_press_start}
          onMoveStart={handle_move_start}
          onMoveEnd={handle_move_end}
          attributionControl={{ compact: true }}
          pixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
          fadeDuration={0}
          renderWorldCopies={false}
          style={{ width: "100%", height: "100%" }}
        >
          <TripLayer trip={is_trip_selection(selected) ? trip : null} />
          <StopsLayer stops={stops} selected_id={selected?.kind === "stop" ? selected.stop.id : null} />
          <PlannerLayer planner={planner} />
          <VehiclesLayer selected_id={selected_vehicle_id(selected, trip)} />
          <LocationLayer position={location.position} />
          <HighlightMarker point={highlight} />
        </MapGL>

        <button
          onClick={handle_locate_click}
          aria-label="Oma sijainti"
          title={LOCATION_HINTS[location.status]}
          className={`absolute top-[38%] right-3 z-10 -translate-y-1/2 p-3 text-xl ${PANEL_SURFACE} ${locate_button_tone(location.status)}`}
        >
          <Locate />
        </button>
        {show_location_problem && (
          <p className={`absolute top-[38%] right-16 left-3 z-10 -translate-y-1/2 p-3 text-sm ${PANEL_SURFACE}`}>
            {LOCATION_HINTS[location.status]}
            {location.detail && <span className="mt-1 block text-xs text-neutral-500">{location.detail}</span>}
          </p>
        )}

        {error && (
          <div className="absolute inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-10 text-red-400">{error}</div>
        )}

        <AnimatePresence>
          {planning && (
            <PlannerSearch
              key="search"
              planner={planner}
              focus={center}
              on_close={close_planner}
              my_location={location.position}
            />
          )}
          {planning && has_planner_results && <PlannerBar key="bar" planner={planner} />}
          {!planning && (
            <motion.button
              key="open-planner"
              {...TOP_PANEL_MOTION}
              onClick={open_planner}
              className={`${TOP_PANEL} flex items-center gap-3 px-4 py-3 text-left text-neutral-400`}
            >
              <Search className="shrink-0 text-lg" />
              Minne mennään?
            </motion.button>
          )}
          {selected?.kind === "stop" && (
            <DeparturesPanel
              key="stop"
              stop={selected.stop}
              on_route_to={route_to}
              on_open_departure={open_departure}
              on_close={close_selection}
            />
          )}
          {is_trip_selection(selected) && (
            <VehiclePanel key="vehicle" source={selected} on_trip={set_trip} on_close={close_selection} />
          )}
        </AnimatePresence>
      </div>
    </ShowOnMapContext.Provider>
  );
}
