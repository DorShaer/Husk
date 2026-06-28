#!/usr/bin/env bun
/**
 * Log Rotation for PAI Observability & Security logs
 *
 * Checks *.jsonl files in MEMORY/OBSERVABILITY/ and MEMORY/SECURITY/.
 * If any exceed 10MB, rotates to {basename}.{YYYY-MM}.archive and creates
 * a fresh empty file. Intended to be called from SessionStart hooks.
 *
 * Usage:
 *   import { rotateLogsIfNeeded } from '';
 *   await rotateLogsIfNeeded();
 */

import { existsSync, statSync, renameSync, writeFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { paiPath } from './paths';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function getYearMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function rotateFile(filePath: string): boolean {
  try {
    const stat = statSync(filePath);
    if (stat.size <= MAX_FILE_SIZE) return false;

    const dir = join(filePath, '..');
    const name = basename(filePath, '.jsonl');
    const archivePath = join(dir, `${name}.${getYearMonth()}.jsonl.archive`);

    // Avoid overwriting an existing archive for the same month
    let finalPath = archivePath;
    let counter = 1;
    while (existsSync(finalPath)) {
      finalPath = join(dir, `${name}.${getYearMonth()}-${counter}.jsonl.archive`);
      counter++;
    }

    renameSync(filePath, finalPath);
    writeFileSync(filePath, '', 'utf-8');

    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.error(`[log-rotation] Rotated ${basename(filePath)} (${sizeMB}MB) → ${basename(finalPath)}`);
    return true;
  } catch (err) {
    console.error(`[log-rotation] Error rotating ${filePath}: ${err}`);
    return false;
  }
}

function rotateDirectory(dirPath: string): number {
  if (!existsSync(dirPath)) return 0;

  let rotated = 0;
  const files = readdirSync(dirPath);
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue;
    if (rotateFile(join(dirPath, file))) rotated++;
  }
  return rotated;
}

/**
 * Check all JSONL log files and rotate any exceeding 10MB.
 * Returns total number of files rotated.
 */
export function rotateLogsIfNeeded(): number {
  const obsDir = paiPath('MEMORY', 'OBSERVABILITY');
  const secDir = paiPath('MEMORY', 'SECURITY');

  let total = 0;
  total += rotateDirectory(obsDir);
  total += rotateDirectory(secDir);

  if (total > 0) {
    console.error(`[log-rotation] Rotated ${total} file(s)`);
  }
  return total;
}
