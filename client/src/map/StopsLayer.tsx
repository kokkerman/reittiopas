// draws every stop on the map once you're zoomed in close enough

import { useMemo } from "react";
import { Layer, Source } from "react-map-gl/maplibre";
import type { FeatureCollection, Point } from "geojson";
import { MODE_COLOR_EXPRESSION as MODE_COLOR } from "../styles/mode_colors";
import type { Stop } from "../types/api_types";

const MIN_ZOOM = 14; // could be higher, or adjusted by client later on

export const STOPS_HIT_LAYER = "stops-hit";

type StopProps = Omit<Stop, "lat" | "lon">;

interface Props {
  stops: Stop[];
  selected_id: string | null;
}

export default function StopsLayer({ stops, selected_id }: Props) {
  const data = useMemo<FeatureCollection<Point, StopProps>>(
    function () {
      return {
        type: "FeatureCollection",
        features: stops.map(function ({ lat, lon, ...properties }) {
          return {
            type: "Feature",
            geometry: { type: "Point", coordinates: [lon, lat] },
            properties,
          };
        }),
      };
    },
    [stops],
  );

  return (
    <Source id="stops" type="geojson" data={data}>
      <Layer
        id="stops-dot"
        type="circle"
        minzoom={MIN_ZOOM}
        paint={{
          "circle-color": MODE_COLOR,
          "circle-radius": ["interpolate", ["linear"], ["zoom"], MIN_ZOOM, 2.5, 17, 6],
        }}
      />
      <Layer
        id="stops-selected"
        type="circle"
        filter={["==", ["get", "id"], selected_id ?? ""]}
        paint={{
          "circle-color": MODE_COLOR,
          "circle-radius": 8,
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
        }}
      />
      <Layer
        id={STOPS_HIT_LAYER}
        type="circle"
        minzoom={MIN_ZOOM}
        paint={{ "circle-radius": 16, "circle-opacity": 0 }}
      />
    </Source>
  );
}
