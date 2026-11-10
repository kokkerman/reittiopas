// distances (claude)

const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LON_EQUATOR = 111320;

export function distance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const mid_lat_radians = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const delta_x = (lon2 - lon1) * M_PER_DEG_LON_EQUATOR * Math.cos(mid_lat_radians);
  const delta_y = (lat2 - lat1) * M_PER_DEG_LAT;
  return Math.sqrt(delta_x * delta_x + delta_y * delta_y);
}

const CELL_DEG_LAT = 0.01;
const CELL_DEG_LON = 0.02;

function cell_y(lat: number): number {
  return Math.floor(lat / CELL_DEG_LAT);
}

function cell_x(lon: number): number {
  return Math.floor(lon / CELL_DEG_LON);
}

export class Grid {
  private cells = new Map<string, number[]>();

  constructor(
    private lats: Float64Array,
    private lons: Float64Array,
  ) {
    for (let i = 0; i < lats.length; i++) {
      const key = this.key(cell_y(lats[i]), cell_x(lons[i]));
      let cell = this.cells.get(key);
      if (!cell) {
        cell = [];
        this.cells.set(key, cell);
      }
      cell.push(i);
    }
  }

  private key(y: number, x: number) {
    return `${y}:${x}`;
  }

  near(lat: number, lon: number, radius: number): { index: number; distance: number }[] {
    const m_per_deg_lon = M_PER_DEG_LON_EQUATOR * Math.cos(lat * (Math.PI / 180));
    const cells_y = Math.ceil(radius / M_PER_DEG_LAT / CELL_DEG_LAT);
    const cells_x = Math.ceil(radius / m_per_deg_lon / CELL_DEG_LON);
    const center_y = cell_y(lat);
    const center_x = cell_x(lon);

    const out: { index: number; distance: number }[] = [];
    for (let y = center_y - cells_y; y <= center_y + cells_y; y++) {
      for (let x = center_x - cells_x; x <= center_x + cells_x; x++) {
        for (const i of this.cells.get(this.key(y, x)) ?? []) {
          const meters = distance(lat, lon, this.lats[i], this.lons[i]);
          if (meters <= radius) out.push({ index: i, distance: meters });
        }
      }
    }
    return out;
  }
}
