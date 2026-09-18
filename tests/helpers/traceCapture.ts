export class TraceCapture {
  lines: string[] = [];

  callback = (msg: string) => {
    this.lines.push(msg);
  };

  last(n: number): string[] {
    return this.lines.slice(-n);
  }

  dump(n = 20): void {
    const tail = this.last(n);
    if (tail.length === 0) {
      console.error("[TraceCapture] (no trace lines captured)");
      return;
    }
    console.error(`[TraceCapture] last ${tail.length} lines:`);
    for (const line of tail) {
      console.error(`  ${line}`);
    }
  }

  clear(): void {
    this.lines.length = 0;
  }
}
