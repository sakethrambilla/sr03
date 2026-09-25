// Screen position of a content point is `x + contentX * scale`.
export type View = { x: number; y: number; scale: number };
export type Size = { width: number; height: number };

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
export const ZOOM_STEP = 1.2;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function fitView(content: Size, viewport: Size, padding = 24): View {
  if (content.width === 0 || content.height === 0) return { x: 0, y: 0, scale: 1 };
  const scale = clampScale(
    Math.min(
      (viewport.width - 2 * padding) / content.width,
      (viewport.height - 2 * padding) / content.height,
    ),
  );
  return {
    x: (viewport.width - content.width * scale) / 2,
    y: (viewport.height - content.height * scale) / 2,
    scale,
  };
}

export function zoomAt(view: View, factor: number, point: { x: number; y: number }): View {
  const scale = clampScale(view.scale * factor);
  const k = scale / view.scale;
  return { x: point.x - (point.x - view.x) * k, y: point.y - (point.y - view.y) * k, scale };
}

export function panBy(view: View, dx: number, dy: number): View {
  return { x: view.x + dx, y: view.y + dy, scale: view.scale };
}
