export type PanelId = "sidebar" | "files" | "agents";
export type PanelEdge = "left" | "right";

export const PANEL_DEFAULTS: Record<PanelId, number> = { sidebar: 288, files: 300, agents: 260 };
export const MIN_PANEL_PX = 200;
export const MAX_PANEL_PX = 560;
// the chat's floor while a panel is dragged wider
export const MIN_MAIN_PX = 360;

export function resizedWidth(start: number, deltaX: number, edge: PanelEdge): number {
  return edge === "right" ? start + deltaX : start - deltaX;
}

// room is the widest this panel may get before the chat drops below MIN_MAIN_PX
export function clampPanelWidth(width: number, room: number): number {
  return Math.round(Math.max(MIN_PANEL_PX, Math.min(width, MAX_PANEL_PX, room)));
}
