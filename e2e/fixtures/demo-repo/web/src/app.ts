import { state } from './state';
import { format } from './util/format';

// A string that only looks like an import: import nothing from './orphan';
export function start(name: string): void {
  state.title = format(name);
}
