import { EventEmitter } from 'events';

export interface TypedEventEmitter<T extends Record<string | symbol, any[]>> {
  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
  emit<K extends keyof T>(event: K, ...args: T[K]): boolean;
  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this;
  removeAllListeners(event?: keyof T): this;
}

export function createTypedEventEmitter<T extends Record<string | symbol, any[]>>(): TypedEventEmitter<T> {
  return new EventEmitter() as TypedEventEmitter<T>;
}