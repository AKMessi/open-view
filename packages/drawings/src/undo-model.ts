export interface UndoableCommand {
  readonly label: string;
  execute(): void;
  undo(): void;
}

/**
 * Reversible Command-Pattern Undo/Redo stack (`UndoModel`) for all drawing mutations.
 */
export class UndoModel {
  private readonly undoStack: UndoableCommand[] = [];
  private readonly redoStack: UndoableCommand[] = [];

  constructor(private readonly maxDepth = 200) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get depth(): number {
    return this.undoStack.length;
  }

  execute(cmd: UndoableCommand): void {
    cmd.execute();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.maxDepth) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    return true;
  }

  redo(): boolean {
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.execute();
    this.undoStack.push(cmd);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
