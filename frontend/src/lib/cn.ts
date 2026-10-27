import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind-aware class merge. Later classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}