// This import closes the loop app -> state -> events -> app.
import { start } from './app';

export function emit(name: string): void {
  if (name === 'restart') start(name);
}
