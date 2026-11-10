// draws the planner's routes on the map.

import { useEffect, useMemo } from "react";
import { Layer, Source, useMap } from "react-map-gl/maplibre";
import { LngLatBounds, type FilterSpecification } from "maplibre-gl";
import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";
import { ITINERARY_COLOR_EXPRESSION } from "../styles/itinerary_colors";
import { label_candidates } from "../utils/label_placement";
import RouteLabels from "./RouteLabels";
import type { Planner } from "../hooks/use_planner";
import { use_planner_groups } from "../hooks/use_route_groups";

const FIT_PADDING = { top: 110, bottom: 140, side: 50 };

export const PLANNER_HIT_LAYER = "planner-hit";

function line(kind: "walk" | "transit", focused: boolean): FilterSpecification {
  return ["all", ["==", ["get", "kind"], kind], ["==", ["get", "focused"], focused]];
}

function point_feature(place: { lat: number; lon: number }, properties: GeoJsonProperties): Feature {
  return { type: "Feature", geometry: { type: "Point", coordinates: [place.lon, place.lat] }, properties };
}

export default function PlannerLayer({ planner }: { planner: Planner }) {
  const { current: map_ref } = useMap();
  const { from, to, itineraries } = planner;
  const { groups, focused, focused_group, shown_option } = use_planner_groups(planner);
  const focused_itinerary = focused !== null ? itineraries?.[focused] : undefined;
  const shown = groups.map(function (_, group_index) {
    return shown_option(group_index);
  });
  const shown_key = shown.join(",");

  const data = useMemo<FeatureCollection>(function () {
    const features: Feature[] = [];

    shown.forEach(function (option, route) {
      const itinerary = itineraries![option];
      const is_focused = route === focused_group;

      for (const leg of itinerary.legs) {
        features.push({
          type: "Feature",
          geometry: { type: "LineString", coordinates: leg.geometry },
          properties: { kind: leg.type, route, option, focused: is_focused },
        });

        const marks_stops = is_focused && leg.type === "transit";
        if (marks_stops) {
          for (const place of [leg.from, leg.to]) {
            features.push(point_feature(place, { kind: "stop", route }));
          }
        }
      }
    });

    if (from) {
      features.push(point_feature(from, { kind: "from" }));
    }
    if (to) {
      features.push(point_feature(to, { kind: "to" }));
    }

    return { type: "FeatureCollection", features };
  }, [from, to, itineraries, focused_group, shown_key]);

  useEffect(function () {
    const map = map_ref?.getMap();
    if (!map || !from || !to) {
      return;
    }

    const bounds = new LngLatBounds([from.lon, from.lat], [from.lon, from.lat]);
    bounds.extend([to.lon, to.lat]);
    for (const leg of focused_itinerary?.legs ?? []) {
      for (const coordinate of leg.geometry) {
        bounds.extend(coordinate);
      }
    }

    map.fitBounds(bounds, {
      padding: {
        top: FIT_PADDING.top,
        bottom: FIT_PADDING.bottom,
        left: FIT_PADDING.side,
        right: FIT_PADDING.side,
      },
      maxZoom: 16,
      duration: 400,
    });
  }, [map_ref, from, to, focused_itinerary]);

  const labels = useMemo(
    function () {
      const group_leaders = groups.map(function (route_group) {
        return itineraries![route_group.options[0]];
      });
      return label_candidates(group_leaders);
    },
    [groups, itineraries],
  );

  const shown_itineraries = shown.map(function (option) {
    return itineraries![option];
  });
  const group_sizes = groups.map(function (route_group) {
    return route_group.options.length;
  });

  function select_group(group_index: number) {
    planner.select(shown_option(group_index));
  }

  return (
    <>
      <Source id="planner" type="geojson" data={data}>
        <Layer
          id="planner-other-walk"
          type="line"
          filter={line("walk", false)}
          layout={{ "line-cap": "round" }}
          paint={{ "line-color": ITINERARY_COLOR_EXPRESSION, "line-width": 2, "line-opacity": 0.3, "line-dasharray": [0.5, 2] }}
        />
        <Layer
          id="planner-other-transit"
          type="line"
          filter={line("transit", false)}
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{ "line-color": ITINERARY_COLOR_EXPRESSION, "line-width": 3, "line-opacity": 0.35 }}
        />

        <Layer
          id="planner-focused-casing"
          type="line"
          filter={line("transit", true)}
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{ "line-color": "#0a0a0a", "line-width": 9 }}
        />
        <Layer
          id="planner-focused-transit"
          type="line"
          filter={line("transit", true)}
          layout={{ "line-cap": "round", "line-join": "round" }}
          paint={{ "line-color": ITINERARY_COLOR_EXPRESSION, "line-width": 6 }}
        />
        <Layer
          id="planner-focused-walk"
          type="line"
          filter={line("walk", true)}
          layout={{ "line-cap": "round" }}
          paint={{ "line-color": ITINERARY_COLOR_EXPRESSION, "line-width": 4, "line-dasharray": [0.5, 1.5] }}
        />
        <Layer
          id="planner-focused-stops"
          type="circle"
          filter={["==", ["get", "kind"], "stop"]}
          paint={{
            "circle-radius": 5,
            "circle-color": "#0a0a0a",
            "circle-stroke-color": ITINERARY_COLOR_EXPRESSION,
            "circle-stroke-width": 3,
          }}
        />

        <Layer
          id="planner-ends"
          type="circle"
          filter={["in", ["get", "kind"], ["literal", ["from", "to"]]]}
          paint={{
            "circle-radius": 8,
            "circle-color": ["match", ["get", "kind"], "from", "#22c55e", "#ef4444"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2,
          }}
        />

        <Layer
          id={PLANNER_HIT_LAYER}
          type="line"
          filter={["in", ["get", "kind"], ["literal", ["walk", "transit"]]]}
          paint={{ "line-color": "#000000", "line-width": 14, "line-opacity": 0 }}
        />
      </Source>

      <RouteLabels
        itineraries={shown_itineraries}
        counts={group_sizes}
        candidates={labels}
        focused={focused_group}
        from={from}
        to={to}
        on_select={select_group}
      />
    </>
  );
}
