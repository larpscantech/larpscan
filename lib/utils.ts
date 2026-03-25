import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function truncateAddress(address: string, front = 6, back = 4): string {
  if (address.length <= front + back + 3) return address;
  return `${address.slice(0, front)}...${address.slice(-back)}`;
}

export function truncateAddressPump(address: string): string {
  if (address.length <= 12) return address;
  const prefix = address.slice(0, 6);
  const suffix = address.endsWith('pump') ? 'pump' : address.slice(-4);
  return `${prefix}...${suffix}`;
}
