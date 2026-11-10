// the maths behind the route labels: scoring spots along each route and pushing overlapping labels apart
// authored by claude 

import type { Itinerary } from "../types/api_types";

type Coord = [number, number];

const MAX_SAMPLES = 60;
const CLEAR_METRES = 300;
const CENTRE_BONUS = 120;
export const MAX_SPOT_SCORE = CLEAR_METRES + CENTRE_BONUS;

function samples(itinerary: Itinerary): Coord[] {
  const all = itinerary.legs.flatMap(function (leg) {
    return leg.geometry as Coord[];
  });
  const step = Math.max(1, Math.ceil(all.length / MAX_SAMPLES));

  return all.filter(function (_, i) {
    return i % step === 0;
  });
}

function metres([lon1, lat1]: Coord, [lon2, lat2]: Coord) {
  const x = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  const y = lat2 - lat1;

  return Math.sqrt(x * x + y * y) * 111320;
}

export interface LabelCandidates {
  points: Coord[];
  scores: number[];
}

function clearance_from(point: Coord, other_points: Coord[]): number {
  let clearance = CLEAR_METRES;
  for (const other_point of other_points) {
    clearance = Math.min(clearance, metres(point, other_point));
  }

  return clearance;
}

function centrality(index: number, point_count: number): number {
  const position_along = index / Math.max(1, point_count - 1);

  return 1 - Math.abs(position_along - 0.5) * 2;
}

export function label_candidates(itineraries: Itinerary[]): LabelCandidates[] {
  const points = itineraries.map(samples);

  return points.map(function (own, i) {
    const others = points
      .filter(function (_, j) {
        return j !== i;
      })
      .flat();
    const scores = own.map(function (point, index) {
      return clearance_from(point, others) + CENTRE_BONUS * centrality(index, own.length);
    });

    return { points: own, scores };
  });
}

export interface ScreenItem {
  x: number;
  y: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
  fixed?: boolean;
}

const GAP = 4;
const ITERATIONS = 40;

// how much of a separating move item `a` takes; item `b` takes the rest.
function share_of_first(item_a: ScreenItem, item_b: ScreenItem): number {
  if (item_a.fixed) {
    return 0;
  }

  if (item_b.fixed) {
    return 1;
  }

  return 0.5;
}

// push overlapping boxes apart. Each round, every overlapping pair is separated
// along the axis where they overlap least (the smallest move that clears them),
// split between the two, or all on the movable one if the other is fixed.
// returns each item's final centre offset from its point.
export function separate(items: ScreenItem[]): [number, number][] {
  const center_x = items.map(function (item) {
    return item.x + item.dx;
  });
  const center_y = items.map(function (item) {
    return item.y + item.dy;
  });

  for (let round = 0; round < ITERATIONS; round++) {
    let moved = false;

    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const item_a = items[a];
        const item_b = items[b];
        if (item_a.fixed && item_b.fixed) {
          continue;
        }

        const delta_x = center_x[b] - center_x[a];
        const delta_y = center_y[b] - center_y[a];
        const overlap_x = (item_a.w + item_b.w) / 2 + GAP - Math.abs(delta_x);
        const overlap_y = (item_a.h + item_b.h) / 2 + GAP - Math.abs(delta_y);
        if (overlap_x <= 0 || overlap_y <= 0) {
          continue;
        }
        moved = true;

        const share_a = share_of_first(item_a, item_b);
        const share_b = 1 - share_a;
        if (overlap_y <= overlap_x) {
          const direction = delta_y !== 0 ? Math.sign(delta_y) : -1;
          center_y[a] -= direction * overlap_y * share_a;
          center_y[b] += direction * overlap_y * share_b;
        } else {
          const direction = delta_x !== 0 ? Math.sign(delta_x) : 1;
          center_x[a] -= direction * overlap_x * share_a;
          center_x[b] += direction * overlap_x * share_b;
        }
      }
    }

    if (!moved) {
      break;
    }
  }

  return items.map(function (item, i): [number, number] {
    return [center_x[i] - item.x, center_y[i] - item.y];
  });
}
