export class RevisionTracker {
  private currentRevision = 0;
  private savedRevision = 0;

  get current(): number {
    return this.currentRevision;
  }

  get dirty(): boolean {
    return this.currentRevision !== this.savedRevision;
  }

  changed(): number {
    this.currentRevision += 1;
    return this.currentRevision;
  }

  reset(): void {
    this.currentRevision = 0;
    this.savedRevision = 0;
  }

  snapshot(): [number, number] {
    return [this.currentRevision, this.savedRevision];
  }

  restore([current, saved]: [number, number]): void {
    this.currentRevision = current;
    this.savedRevision = saved;
  }

  acceptSavedRevision(revision: number): boolean {
    if (revision !== this.currentRevision) {
      return false;
    }
    this.savedRevision = revision;
    return true;
  }
}
