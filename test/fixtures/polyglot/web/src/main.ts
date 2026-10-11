import './app.js'; // TypeScript writes the .js name of app.ts
import { fmt } from '@/util/fmt';
import type { Model } from './types';
import React from 'react';
// import './commented-out';
const text = "import './inside-a-string'";
export const run = (m: Model) => fmt(String(m)) + text + String(React);
