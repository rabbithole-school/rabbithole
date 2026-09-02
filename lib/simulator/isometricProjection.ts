export interface IsoPoint {
  x: number;
  y: number;
}

export interface IsoSize {
  width: number;
  height: number;
}

export interface IsoGeometry {
  tileWidth: number;
  tileHeight: number;
  tileDepth: number;
}

export interface IsoBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface IsoFit {
  geometry: IsoGeometry;
  worldBounds: IsoBounds;
  contentBounds: IsoBounds;
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface IsoCamera {
  scale: number;
  x: number;
  y: number;
}

export const DEFAULT_ISOMETRIC_GEOMETRY: IsoGeometry = {
  tileWidth: 2,
  tileHeight: 1,
  tileDepth: 0.18,
};

export const MIN_ISO_ZOOM = 1;
export const MAX_ISO_ZOOM = 8;

export function projectIsometric(
  point: IsoPoint,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): IsoPoint {
  return {
    x: ((point.x - point.y) * geometry.tileWidth) / 2,
    y: ((point.x + point.y) * geometry.tileHeight) / 2,
  };
}

export function unprojectIsometric(
  point: IsoPoint,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): IsoPoint {
  return {
    x: point.x / geometry.tileWidth + point.y / geometry.tileHeight,
    y: point.y / geometry.tileHeight - point.x / geometry.tileWidth,
  };
}

/** The chess-square center for a logical cell, never a grid intersection. */
export function isometricCellCenter(
  cell: IsoPoint,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): IsoPoint {
  return projectIsometric({ x: cell.x + 0.5, y: cell.y + 0.5 }, geometry);
}

/** Diamond vertices in top, right, bottom, left painter order. */
export function isometricTileDiamond(
  cell: IsoPoint,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): readonly [IsoPoint, IsoPoint, IsoPoint, IsoPoint] {
  return [
    projectIsometric(cell, geometry),
    projectIsometric({ x: cell.x + 1, y: cell.y }, geometry),
    projectIsometric({ x: cell.x + 1, y: cell.y + 1 }, geometry),
    projectIsometric({ x: cell.x, y: cell.y + 1 }, geometry),
  ];
}

export function isometricWorldBounds(
  grid: IsoSize,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): IsoBounds {
  const corners = [
    projectIsometric({ x: 0, y: 0 }, geometry),
    projectIsometric({ x: grid.width, y: 0 }, geometry),
    projectIsometric({ x: 0, y: grid.height }, geometry),
    projectIsometric({ x: grid.width, y: grid.height }, geometry),
  ];
  const minX = Math.min(...corners.map((point) => point.x));
  const maxX = Math.max(...corners.map((point) => point.x));
  const minY = Math.min(...corners.map((point) => point.y));
  const maxY = Math.max(...corners.map((point) => point.y)) + geometry.tileDepth;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export function compareIsometricDepth(
  a: { x: number; y: number; layer?: number; id?: string },
  b: { x: number; y: number; layer?: number; id?: string },
): number {
  return (
    a.x + a.y - (b.x + b.y) ||
    (a.layer ?? 0) - (b.layer ?? 0) ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

export function sortIsometricDepth<T extends { x: number; y: number; layer?: number; id?: string }>(
  items: readonly T[],
): T[] {
  return [...items].sort(compareIsometricDepth);
}

export function fitIsometricCamera(
  grid: IsoSize,
  viewport: IsoSize,
  padding = 0,
  geometry: IsoGeometry = DEFAULT_ISOMETRIC_GEOMETRY,
): IsoFit {
  const worldBounds = isometricWorldBounds(grid, geometry);
  const safePadding = Math.max(0, Math.min(padding, viewport.width / 2, viewport.height / 2));
  const availableWidth = Math.max(1, viewport.width - safePadding * 2);
  const availableHeight = Math.max(1, viewport.height - safePadding * 2);
  const scale = Math.min(availableWidth / worldBounds.width, availableHeight / worldBounds.height);
  const offsetX = (viewport.width - worldBounds.width * scale) / 2 - worldBounds.minX * scale;
  const offsetY = (viewport.height - worldBounds.height * scale) / 2 - worldBounds.minY * scale;
  const minX = offsetX + worldBounds.minX * scale;
  const minY = offsetY + worldBounds.minY * scale;
  const maxX = offsetX + worldBounds.maxX * scale;
  const maxY = offsetY + worldBounds.maxY * scale;
  return {
    geometry,
    worldBounds,
    contentBounds: {
      minX,
      minY,
      maxX,
      maxY,
      width: maxX - minX,
      height: maxY - minY,
    },
    scale,
    offsetX,
    offsetY,
  };
}

export function clampIsometricCamera(
  camera: IsoCamera,
  fit: IsoFit | null,
  viewport: IsoSize,
): IsoCamera {
  const scale = Math.min(MAX_ISO_ZOOM, Math.max(MIN_ISO_ZOOM, camera.scale));
  if (!fit) return { ...camera, scale };
  const clampAxis = (
    translation: number,
    contentMin: number,
    contentMax: number,
    viewportSpan: number,
  ): number => {
    const lower = viewportSpan - scale * contentMax;
    const upper = -scale * contentMin;
    return lower > upper ? (lower + upper) / 2 : Math.min(upper, Math.max(lower, translation));
  };
  return {
    scale,
    x: clampAxis(camera.x, fit.contentBounds.minX, fit.contentBounds.maxX, viewport.width),
    y: clampAxis(camera.y, fit.contentBounds.minY, fit.contentBounds.maxY, viewport.height),
  };
}

export function isometricScreenPoint(
  logicalPoint: IsoPoint,
  fit: IsoFit,
  camera: IsoCamera = { scale: 1, x: 0, y: 0 },
): IsoPoint {
  return fittedIsometricPoint(projectIsometric(logicalPoint, fit.geometry), fit, camera);
}

export function fittedIsometricPoint(
  projectedPoint: IsoPoint,
  fit: IsoFit,
  camera: IsoCamera = { scale: 1, x: 0, y: 0 },
): IsoPoint {
  return {
    x: camera.x + camera.scale * (fit.offsetX + projectedPoint.x * fit.scale),
    y: camera.y + camera.scale * (fit.offsetY + projectedPoint.y * fit.scale),
  };
}

export function unprojectIsometricScreen(
  screenPoint: IsoPoint,
  fit: IsoFit,
  camera: IsoCamera = { scale: 1, x: 0, y: 0 },
): IsoPoint {
  const fitted = {
    x: (screenPoint.x - camera.x) / camera.scale,
    y: (screenPoint.y - camera.y) / camera.scale,
  };
  return unprojectIsometric(
    {
      x: (fitted.x - fit.offsetX) / fit.scale,
      y: (fitted.y - fit.offsetY) / fit.scale,
    },
    fit.geometry,
  );
}

export function isometricCellAtScreen(
  screenPoint: IsoPoint,
  fit: IsoFit,
  camera: IsoCamera,
  grid: IsoSize,
): IsoPoint | null {
  const logical = unprojectIsometricScreen(screenPoint, fit, camera);
  const x = Math.floor(logical.x);
  const y = Math.floor(logical.y);
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height ? { x, y } : null;
}
