export interface CrosshairSyncEvent {
  sourceTileId: string;
  timeMs: number | null;
}

/**
 * Lightweight zero-React mediator for cross-tile crosshair synchronization
 * across arbitrary multi-chart grids (1x1..4x2) even when tiles display different timeframes.
 */
export class WorkspaceSyncBus {
  private crosshairListeners = new Set<(ev: CrosshairSyncEvent) => void>();

  emitCrosshair(sourceTileId: string, timeMs: number | null): void {
    for (const fn of this.crosshairListeners) {
      fn({ sourceTileId, timeMs });
    }
  }

  onCrosshair(fn: (ev: CrosshairSyncEvent) => void): () => void {
    this.crosshairListeners.add(fn);
    return () => this.crosshairListeners.delete(fn);
  }
}
