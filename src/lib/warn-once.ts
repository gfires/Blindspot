const seen = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  console.warn(message);
}

export function resetWarnOnce(): void {
  seen.clear();
}
