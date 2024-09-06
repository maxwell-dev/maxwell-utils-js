export function nowInSeconds(): number {
  return new Date().getTime() / 1000;
}

export function nowInMilliseconds(): number {
  return new Date().getTime();
}

export async function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
